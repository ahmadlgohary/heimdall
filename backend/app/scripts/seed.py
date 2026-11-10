"""Create (or reset) the demo environment (plan §14.3).

    python -m app.scripts.seed            # reset the demo account, add history, send a few live events
    python -m app.scripts.seed --no-live  # history only (no worker needed)
    make seed                             # same, inside docker compose

What it builds for DEMO_EMAIL / DEMO_PASSWORD:

* Five endpoints, all pointing at the built-in test receiver (DEMO_RECEIVER_URL),
  each with a different behaviour, so anything a visitor sends is delivered for real.
* About 30 days of sample history, stored with source="demo_fixture". Its delivery
  attempts are *simulated* to match each endpoint's behaviour: they were never sent.
  The API returns the source and the UI labels these events, so sample data can't
  pass for real processing. Fixtures get no outbox rows, so nothing publishes them.
* A few live events, ingested through the real pipeline (outbox → RabbitMQ → worker
  → receiver). These need the publisher and worker running.

Every run deletes the previous demo account (and its stored payloads) first, so it's
safe to run on a schedule to undo whatever visitors changed.
"""

import argparse
import asyncio
import random
import uuid
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from typing import Any

from sqlalchemy import select

from app.core.config import Settings, get_settings
from app.core.security import SecretBox, generate_api_key, generate_signing_secret, hash_password
from app.db.models import (
    ApiKey,
    Delivery,
    DeliveryAttempt,
    Endpoint,
    Event,
    EventSource,
    EventStatus,
    TriggerType,
    User,
)
from app.db.session import create_engine, create_session_factory
from app.services.event_service import EventService, build_envelope, request_fingerprint
from app.services.storage_service import PayloadStorage, build_storage, payload_key
from app.utils.retry import backoff_delay

UPLOAD_CONCURRENCY = 16


# ---------- endpoints ----------


@dataclass(frozen=True)
class DemoEndpoint:
    name: str
    behaviour: str  # path on the test receiver; the fixture simulation mirrors it
    description: str
    weight: int
    types: tuple[str, ...]
    enabled: bool = True


ENDPOINTS = (
    DemoEndpoint(
        "Order service",
        "ok",
        "Order lifecycle events. Answers 200.",
        6,
        ("order.created", "order.paid", "order.refunded"),
    ),
    DemoEndpoint(
        "Billing",
        "flaky",
        "Invoices and subscriptions. Answers 503 on the first attempt, then 200 on the retry.",
        3,
        ("invoice.paid", "invoice.payment_failed", "subscription.updated"),
    ),
    DemoEndpoint(
        "Partner relay",
        "ratelimit",
        "Rate-limits the first attempt with 429 and Retry-After: 40, then accepts.",
        2,
        ("customer.created", "order.refunded"),
    ),
    DemoEndpoint(
        "Fulfilment (staging)",
        "fail",
        "Always answers 500, so deliveries use all five attempts and fail. Try a replay.",
        1,
        ("shipment.dispatched", "order.paid"),
    ),
    DemoEndpoint(
        "Legacy CRM",
        "notfound",
        "Answers 404, which isn't retried. Disabled a week ago.",
        1,
        ("customer.created",),
        enabled=False,
    ),
)


# ---------- payloads ----------


def make_data(rng: random.Random, event_type: str) -> dict[str, Any]:
    n = rng.randint(1000, 9999)
    amount = round(rng.uniform(9, 480), 2)
    if event_type.startswith("order."):
        return {
            "order_id": f"ORD-{n}",
            "amount": amount,
            "currency": rng.choice(["USD", "EUR", "GBP"]),
            "customer": {"id": f"cus_{n}", "email": f"buyer{n}@example.com"},
            "items": [
                {
                    "sku": f"SKU-{n + i}",
                    "quantity": rng.randint(1, 3),
                    "unit_price": round(rng.uniform(5, 120), 2),
                }
                for i in range(rng.randint(1, 3))
            ],
        }
    if event_type.startswith("invoice."):
        return {
            "invoice_id": f"INV-2026-{n}",
            "amount_due": amount,
            "currency": "USD",
            "attempt_count": rng.randint(1, 3) if event_type.endswith("failed") else 1,
        }
    if event_type == "subscription.updated":
        return {
            "subscription_id": f"sub_{n}",
            "status": rng.choice(["active", "active", "past_due"]),
            "plan": {"id": rng.choice(["pro_monthly", "team_annual"]), "amount": amount},
        }
    if event_type == "customer.created":
        return {
            "customer_id": f"cus_{n}",
            "email": f"new{n}@example.com",
            "plan": rng.choice(["free", "pro", "team"]),
        }
    return {
        "shipment_id": f"SHP-{n}",
        "carrier": rng.choice(["UPS", "DHL", "FedEx"]),
        "tracking_number": f"1Z{n}{n}",
    }


# ---------- simulated attempts (fixtures only) ----------

OK_HEADERS = {"content-type": "application/json", "server": "uvicorn"}


@dataclass
class SimAttempt:
    offset: timedelta  # from the event's creation
    http_status: int | None
    body: str | None
    headers: dict[str, str] | None
    duration_ms: int | None
    error: str | None = None


@dataclass
class SimExecution:
    trigger: str
    created_offset: timedelta
    attempts: list[SimAttempt] = field(default_factory=list)

    @property
    def status(self) -> str:
        last = self.attempts[-1]
        return (
            EventStatus.DELIVERED
            if last.http_status and 200 <= last.http_status < 300
            else EventStatus.FAILED
        )


def ok(rng: random.Random, offset: timedelta) -> SimAttempt:
    return SimAttempt(offset, 200, '{"received":true}', OK_HEADERS, rng.randint(35, 260))


def simulate(rng: random.Random, behaviour: str) -> list[SimExecution]:
    """Attempt histories that match what the receiver behaviour really does."""
    first = timedelta(seconds=1.5)
    execution = SimExecution(TriggerType.AUTOMATIC, timedelta())

    if behaviour == "ok":
        if rng.random() < 0.04:  # an occasional transient hiccup, recovered on the retry
            execution.attempts.append(
                SimAttempt(
                    first,
                    502,
                    "<html>502 Bad Gateway</html>",
                    {"content-type": "text/html"},
                    rng.randint(20, 90),
                )
            )
            execution.attempts.append(ok(rng, first + timedelta(seconds=backoff_delay(2))))
        else:
            execution.attempts.append(ok(rng, first))
        return [execution]

    if behaviour == "flaky":
        execution.attempts.append(
            SimAttempt(first, 503, '{"error":"warming up"}', OK_HEADERS, rng.randint(30, 120))
        )
        execution.attempts.append(ok(rng, first + timedelta(seconds=backoff_delay(2))))
        return [execution]

    if behaviour == "ratelimit":
        execution.attempts.append(
            SimAttempt(
                first,
                429,
                '{"error":"slow down"}',
                {"content-type": "application/json", "retry-after": "40"},
                rng.randint(15, 60),
            )
        )
        execution.attempts.append(ok(rng, first + timedelta(seconds=max(backoff_delay(2), 40))))
        return [execution]

    if behaviour == "notfound":
        execution.attempts.append(
            SimAttempt(
                first, 404, "<h1>404 Not Found</h1>", {"content-type": "text/html"}, rng.randint(40, 200)
            )
        )
        return [execution]

    # "fail": every attempt fails; five attempts on the backoff schedule
    elapsed = first
    for n in range(1, 6):
        if n > 1:
            elapsed += timedelta(seconds=backoff_delay(n))
        if rng.random() < 0.25:
            execution.attempts.append(SimAttempt(elapsed, None, None, None, 10_000, "Timed out after 10s"))
        else:
            execution.attempts.append(
                SimAttempt(elapsed, 500, '{"error":"internal_error"}', OK_HEADERS, rng.randint(80, 900))
            )
    executions = [execution]
    if rng.random() < 0.3:  # someone tried a manual replay a few hours later; it failed again
        replay = SimExecution(TriggerType.MANUAL, timedelta(hours=rng.randint(2, 6)))
        r_elapsed = replay.created_offset + first
        for n in range(1, 6):
            if n > 1:
                r_elapsed += timedelta(seconds=backoff_delay(n))
            replay.attempts.append(
                SimAttempt(r_elapsed, 500, '{"error":"internal_error"}', OK_HEADERS, rng.randint(80, 900))
            )
        executions.append(replay)
    return executions


# ---------- seeding ----------


@dataclass
class Fixture:
    event: Event
    body: bytes
    deliveries: list[Delivery]
    attempts: list[DeliveryAttempt]


async def reset_demo_account(factory, storage: PayloadStorage, email: str) -> int:
    """Delete the demo user (cascades to everything it owns) and its stored payloads."""
    async with factory() as db:
        user = await db.scalar(select(User).where(User.email == email.lower()))
        if user is None:
            return 0
        keys = list(
            await db.scalars(
                select(Event.payload_key)
                .join(Endpoint, Endpoint.id == Event.endpoint_id)
                .where(Endpoint.user_id == user.id)
            )
        )
        await db.delete(user)
        await db.commit()
    sem = asyncio.Semaphore(UPLOAD_CONCURRENCY)

    async def remove(key: str) -> None:
        async with sem:
            await storage.delete(key)

    await asyncio.gather(*(remove(k) for k in keys))
    return len(keys)


def build_fixtures(
    rng: random.Random,
    user: User,
    endpoints: list[tuple[Endpoint, DemoEndpoint]],
    *,
    count: int,
    days: int,
    now: datetime,
) -> list[Fixture]:
    # Fixtures are all settled: the newest is an hour old, so even a failing endpoint's
    # 41-minute retry schedule has finished.
    newest = now - timedelta(hours=1)
    oldest = now - timedelta(days=days)
    span = (newest - oldest).total_seconds()
    # denser towards the present, like real traffic growth
    times = sorted(oldest + timedelta(seconds=span * (1 - rng.random() ** 2.2)) for _ in range(count))
    total_weight = sum(d.weight for _, d in endpoints)
    disabled_since = now - timedelta(days=7)

    def weighted_endpoint() -> tuple[Endpoint, DemoEndpoint]:
        pick = rng.uniform(0, total_weight)
        for pair in endpoints:
            pick -= pair[1].weight
            if pick <= 0:
                return pair
        return endpoints[-1]

    fixtures = []
    for created in times:
        endpoint, demo = weighted_endpoint()
        if not endpoint.enabled and created > disabled_since:
            endpoint, demo = endpoints[0]
        event_type = rng.choice(demo.types)
        data = make_data(rng, event_type)
        event_id = uuid.uuid4()
        body = build_envelope(event_id, event_type, created, data)
        executions = simulate(rng, demo.behaviour)
        idem = f"{event_type.split('.')[0]}-{rng.randint(10000, 99999)}" if rng.random() < 0.5 else None
        event = Event(
            id=event_id,
            endpoint_id=endpoint.id,
            event_type=event_type,
            payload_key=payload_key(user.id, endpoint.id, event_id),
            payload_size=len(body),
            payload_hash=request_fingerprint(event_type, data),
            idempotency_key=idem,
            status=executions[-1].status,
            source=EventSource.DEMO_FIXTURE,
            created_at=created,
        )
        deliveries, attempts = [], []
        for number, execution in enumerate(executions, start=1):
            first_at = created + execution.attempts[0].offset
            last = execution.attempts[-1]
            delivery = Delivery(
                id=uuid.uuid4(),
                event_id=event_id,
                execution_number=number,
                trigger_type=execution.trigger,
                status=execution.status,
                current_attempt=len(execution.attempts),
                max_attempts=5,
                started_at=first_at,
                completed_at=created + last.offset + timedelta(milliseconds=last.duration_ms or 0),
                created_at=created + execution.created_offset,
            )
            deliveries.append(delivery)
            for n, sim in enumerate(execution.attempts, start=1):
                attempts.append(
                    DeliveryAttempt(
                        delivery_id=delivery.id,
                        attempt_number=n,
                        http_status=sim.http_status,
                        response_body=sim.body,
                        response_headers=sim.headers,
                        duration_ms=sim.duration_ms,
                        error_message=sim.error,
                        attempted_at=created + sim.offset,
                    )
                )
        fixtures.append(Fixture(event, body, deliveries, attempts))
    return fixtures


async def seed(
    settings: Settings,
    *,
    events: int = 260,
    days: int = 30,
    live: int = 3,
    random_seed: int | None = None,
    storage: PayloadStorage | None = None,
    factory=None,
    log=print,
) -> dict[str, Any]:
    engine = None
    if factory is None:
        engine = create_engine(settings)
        factory = create_session_factory(engine)
    storage = storage or build_storage(settings)
    rng = random.Random(random_seed)
    box = SecretBox(settings.fernet_key)
    receiver = settings.demo_receiver_base
    now = datetime.now(UTC)

    try:
        removed = await reset_demo_account(factory, storage, settings.demo_email)
        if removed:
            log(f"Removed the previous demo account and {removed} stored payloads.")

        user = User(
            id=uuid.uuid4(),
            email=settings.demo_email.lower(),
            password_hash=await asyncio.to_thread(hash_password, settings.demo_password),
            created_at=now - timedelta(days=days + 5),
        )
        endpoints: list[tuple[Endpoint, DemoEndpoint]] = []
        for i, demo in enumerate(ENDPOINTS):
            created = now - timedelta(days=days + 4 - i)
            endpoints.append(
                (
                    Endpoint(
                        id=uuid.uuid4(),
                        user_id=user.id,
                        name=demo.name,
                        url=f"{receiver}/hooks/{demo.behaviour}",
                        description=demo.description,
                        enabled=demo.enabled,
                        signing_secret_encrypted=box.encrypt(generate_signing_secret()),
                        created_at=created,
                        updated_at=now - timedelta(days=7) if not demo.enabled else created,
                    ),
                    demo,
                )
            )
        keys = []
        for name, revoked in (("Demo backend", False), ("Old laptop script", True)):
            k = generate_api_key()
            keys.append(
                ApiKey(
                    user_id=user.id,
                    name=name,
                    key_prefix=k.prefix,
                    key_hash=k.hash,
                    created_at=now - timedelta(days=days),
                    last_used_at=now - timedelta(hours=2) if not revoked else now - timedelta(days=days - 2),
                    revoked_at=now - timedelta(days=days - 5) if revoked else None,
                )
            )

        fixtures = build_fixtures(rng, user, endpoints, count=events, days=days, now=now)

        # Store payloads first: if the database write then fails, they are removed again.
        sem = asyncio.Semaphore(UPLOAD_CONCURRENCY)

        async def upload(f: Fixture) -> None:
            async with sem:
                await storage.put(f.event.payload_key, f.body)

        log(f"Uploading {len(fixtures)} sample payloads to {settings.storage_backend} storage…")
        await asyncio.gather(*(upload(f) for f in fixtures))

        try:
            async with factory() as db:
                # flush parent tables first: endpoints and keys reference users.id
                db.add(user)
                await db.flush()
                db.add_all([e for e, _ in endpoints])
                db.add_all(keys)
                await db.flush()
                for f in fixtures:
                    db.add(f.event)
                await db.flush()
                for f in fixtures:
                    db.add_all(f.deliveries)
                await db.flush()
                for f in fixtures:
                    db.add_all(f.attempts)
                await db.commit()
        except BaseException:
            await asyncio.gather(
                *(storage.delete(f.event.payload_key) for f in fixtures), return_exceptions=True
            )
            raise

        live_ids = []
        if live:
            # Real events through the real pipeline: one each to the first few enabled endpoints.
            enabled = [(e, d) for e, d in endpoints if d.enabled]
            async with factory() as db:
                service = EventService(db, storage, settings)
                for i in range(live):
                    target, demo = enabled[i % len(enabled)]
                    endpoint = await db.get(Endpoint, target.id)
                    event_type = demo.types[0]
                    result = await service.ingest(
                        endpoint, event_type=event_type, data=make_data(rng, event_type)
                    )
                    live_ids.append(result.event.id)

        statuses: dict[str, int] = {}
        for f in fixtures:
            statuses[f.event.status] = statuses.get(f.event.status, 0) + 1
        summary = {
            "email": settings.demo_email,
            "password": settings.demo_password,
            "endpoints": len(endpoints),
            "fixtures": len(fixtures),
            "fixture_statuses": statuses,
            "live_events": len(live_ids),
            "receiver": receiver,
        }
        return summary
    finally:
        if engine is not None:
            await engine.dispose()


def main() -> None:
    parser = argparse.ArgumentParser(description="Create or reset the Heimdall demo environment.")
    parser.add_argument("--events", type=int, default=260, help="sample events to generate (default 260)")
    parser.add_argument("--days", type=int, default=30, help="days of history (default 30)")
    parser.add_argument(
        "--live", type=int, default=3, help="real events to send through the pipeline (default 3)"
    )
    parser.add_argument("--no-live", action="store_const", const=0, dest="live", help="skip live events")
    parser.add_argument("--seed", type=int, default=None, help="random seed for reproducible history")
    args = parser.parse_args()

    settings = get_settings()
    summary = asyncio.run(
        seed(settings, events=args.events, days=args.days, live=args.live, random_seed=args.seed)
    )
    print()
    print("Demo environment ready")
    print(f"  Sign in:    {summary['email']} / {summary['password']}")
    print(f"  Endpoints:  {summary['endpoints']}, delivering to {summary['receiver']}")
    print(f"  History:    {summary['fixtures']} sample events, labelled demo fixtures")
    print(f"              {summary['fixture_statuses']}")
    if summary["live_events"]:
        print(f"  Live:       {summary['live_events']} real events queued for the publisher and worker")
    if not settings.demo_enabled:
        print("  Note: DEMO_ENABLED is false, so the sign-in page won't show the demo credentials.")


if __name__ == "__main__":
    main()
