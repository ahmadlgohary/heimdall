"""Private demo copies ("sandboxes").

Every demo sign-in gets its own copy of the demo template (the account the seed
script builds, DEMO_EMAIL). The visitor can change anything: create endpoints,
send events, replay, manage keys. Nobody else sees it, and it's deleted on
sign-out or after DEMO_SANDBOX_TTL_MINUTES. The template itself is never signed
in to, so it never drifts.

Copying is cheap: rows are copied with new ids in one transaction (a few hundred
to a thousand rows), and the sample payloads in object storage are *shared*: a
copied event points at the template's object, read-only. Only objects a visitor
creates (events they send) live under the copy's own key prefix and are removed
with it. Timestamps are shifted at copy time so the history always looks recent.
"""

import logging
import secrets
import uuid
from datetime import UTC, datetime, timedelta
from typing import Any

from sqlalchemy import delete, func, insert, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.core.config import Settings
from app.core.exceptions import AppError, RateLimited
from app.core.security import generate_api_key
from app.db.models import ApiKey, Delivery, DeliveryAttempt, Endpoint, Event, EventStatus, User
from app.services.storage_service import PayloadStorage

logger = logging.getLogger(__name__)

SANDBOX_DOMAIN = "demo.heimdall.invalid"
# Not a valid Argon2 hash: nobody can sign in to a copy with a password.
NO_PASSWORD = "!demo-sandbox"  # noqa: S105 (deliberately not a valid hash)


class DemoUnavailable(AppError):
    status_code = 503
    code = "DEMO_UNAVAILABLE"


def own_prefix(user_id: uuid.UUID) -> str:
    """Objects a user created live under this prefix; anything else is shared."""
    return f"events/{user_id}/"


def _row(obj: Any) -> dict[str, Any]:
    return {c.key: getattr(obj, c.key) for c in obj.__table__.columns}


def _shift(row: dict[str, Any], delta: timedelta) -> dict[str, Any]:
    return {k: (v + delta if isinstance(v, datetime) else v) for k, v in row.items()}


async def create_sandbox(session: AsyncSession, settings: Settings) -> User:
    now = datetime.now(UTC)
    template = await session.scalar(select(User).where(User.email == settings.demo_email.lower()))
    if template is None:
        raise DemoUnavailable("The demo isn't set up yet. Try again shortly.")
    active = await session.scalar(select(func.count()).select_from(User).where(User.demo_expires_at > now))
    if active >= settings.demo_max_sandboxes:
        raise RateLimited(
            "The demo is busy right now. Try again in a few minutes, or create your own account.",
            code="DEMO_BUSY",
            headers={"Retry-After": "120"},
        )

    endpoints = list(await session.scalars(select(Endpoint).where(Endpoint.user_id == template.id)))
    endpoint_ids = [e.id for e in endpoints]
    # only settled history: an in-flight delivery would have nothing driving it in the copy
    events = list(
        await session.scalars(
            select(Event).where(Event.endpoint_id.in_(endpoint_ids), Event.status.in_(EventStatus.SETTLED))
        )
    )
    event_ids = [e.id for e in events]
    deliveries = list(await session.scalars(select(Delivery).where(Delivery.event_id.in_(event_ids))))
    attempts = list(
        await session.scalars(
            select(DeliveryAttempt).where(DeliveryAttempt.delivery_id.in_([d.id for d in deliveries]))
        )
    )
    keys = list(await session.scalars(select(ApiKey).where(ApiKey.user_id == template.id)))

    # make the newest sample event an hour old, whenever the template was seeded
    newest = max((e.created_at for e in events), default=now - timedelta(hours=1))
    delta = (now - timedelta(hours=1)) - newest

    user_id = uuid.uuid4()
    ids: dict[uuid.UUID, uuid.UUID] = {}

    def new_id(old: uuid.UUID) -> uuid.UUID:
        return ids.setdefault(old, uuid.uuid4())

    user_row = {
        "id": user_id,
        "email": f"demo-{secrets.token_hex(6)}@{SANDBOX_DOMAIN}",
        "password_hash": NO_PASSWORD,
        "demo_expires_at": now + timedelta(minutes=settings.demo_sandbox_ttl_minutes),
        "created_at": template.created_at + delta,
        "updated_at": now,
    }
    endpoint_rows = [{**_shift(_row(e), delta), "id": new_id(e.id), "user_id": user_id} for e in endpoints]
    event_rows = [
        {**_shift(_row(e), delta), "id": new_id(e.id), "endpoint_id": ids[e.endpoint_id]}  # payload shared
        for e in events
    ]
    delivery_rows = [
        {**_shift(_row(d), delta), "id": new_id(d.id), "event_id": ids[d.event_id], "locked_until": None}
        for d in deliveries
    ]
    attempt_rows = [
        {**_shift(_row(a), delta), "id": uuid.uuid4(), "delivery_id": ids[a.delivery_id]} for a in attempts
    ]
    key_rows = []
    for k in keys:  # fresh key material: hashes are unique, and raw keys are never stored
        generated = generate_api_key()
        key_rows.append(
            {
                **_shift(_row(k), delta),
                "id": uuid.uuid4(),
                "user_id": user_id,
                "key_prefix": generated.prefix,
                "key_hash": generated.hash,
            }
        )

    # parents first; core inserts are batched (executemany)
    await session.execute(insert(User.__table__), [user_row])
    for table, rows in (
        (Endpoint.__table__, endpoint_rows),
        (ApiKey.__table__, key_rows),
        (Event.__table__, event_rows),
        (Delivery.__table__, delivery_rows),
        (DeliveryAttempt.__table__, attempt_rows),
    ):
        if rows:
            await session.execute(insert(table), rows)
    await session.commit()
    logger.info("demo copy created", extra={"user_id": str(user_id), "events": len(event_rows)})
    return await session.get(User, user_id)


async def own_payload_keys(session: AsyncSession, user_id: uuid.UUID) -> list[str]:
    keys = await session.scalars(
        select(Event.payload_key)
        .join(Endpoint, Endpoint.id == Event.endpoint_id)
        .where(Endpoint.user_id == user_id)
    )
    return [k for k in keys if k.startswith(own_prefix(user_id))]


async def delete_sandboxes(session: AsyncSession, storage: PayloadStorage, user_ids: list[uuid.UUID]) -> int:
    """Delete copies (rows cascade) and the objects their visitors created. Shared ones stay."""
    if not user_ids:
        return 0
    keys: list[str] = []
    for uid in user_ids:
        keys += await own_payload_keys(session, uid)
    result = await session.execute(
        delete(User).where(User.id.in_(user_ids), User.demo_expires_at.is_not(None))
    )
    await session.commit()
    for key in keys:
        await storage.delete(key)
    return result.rowcount or 0


async def sweep_expired(
    factory: async_sessionmaker[AsyncSession], storage: PayloadStorage, *, limit: int = 50
) -> int:
    async with factory() as session:
        expired = list(
            await session.scalars(
                select(User.id).where(User.demo_expires_at < datetime.now(UTC)).limit(limit)
            )
        )
        removed = await delete_sandboxes(session, storage, expired)
    if removed:
        logger.info("expired demo copies removed", extra={"count": removed})
    return removed


async def delete_all_sandboxes(factory: async_sessionmaker[AsyncSession], storage: PayloadStorage) -> int:
    async with factory() as session:
        ids = list(await session.scalars(select(User.id).where(User.demo_expires_at.is_not(None))))
        return await delete_sandboxes(session, storage, ids)
