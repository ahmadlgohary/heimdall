"""Executes one delivery attempt: claim → send → record (plan §3.5).

Idempotency and concurrency:
- A job is (delivery_id, attempt_number). The claim is a row-locked
  transition that only succeeds if the attempt is the next one due and no live
  lease exists, so two workers never send the same attempt.
- The HTTP request runs outside any transaction.
- The attempt row has a unique (delivery_id, attempt_number) constraint, so a
  duplicate message can never record a second result.
- The caller acks the message only after `process` returns, i.e. after commit.
"""

import asyncio
import logging
import time
import uuid
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from enum import StrEnum
from urllib.parse import urlsplit, urlunsplit

import httpx
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.core.config import Settings
from app.core.security import SecretBox
from app.db.models import Delivery, DeliveryAttempt, Endpoint, Event, EventStatus
from app.messaging.messages import DeliveryJob
from app.services.delivery_service import enqueue_attempt
from app.services.storage_service import PayloadStorage, StorageError
from app.utils.retry import decide_retry, is_success, parse_retry_after
from app.utils.signatures import signature_header
from app.utils.validators import DestinationError, UnresolvableHost, parse_destination, resolve_destination

logger = logging.getLogger(__name__)

USER_AGENT = "Heimdall/1.0 (+https://github.com/heimdall)"
INTERNAL_RETRY_DELAY = timedelta(seconds=30)
# Headers we never store or show: credentials and cookies from the receiver.
REDACTED_RESPONSE_HEADERS = {
    "set-cookie",
    "authorization",
    "proxy-authorization",
    "cookie",
    "www-authenticate",
}
MAX_STORED_HEADERS = 40


class Outcome(StrEnum):
    DELIVERED = "delivered"
    RETRY_SCHEDULED = "retry_scheduled"
    FAILED = "failed"
    SKIPPED = "skipped"
    RESCHEDULED = "rescheduled"


@dataclass
class AttemptResult:
    http_status: int | None = None
    body: str | None = None
    headers: dict[str, str] | None = None
    duration_ms: int | None = None
    error: str | None = None
    # None: decide from the HTTP status. False: never retry (e.g. blocked destination).
    retryable: bool | None = None
    retry_after: int | None = None
    attempted_at: datetime = field(default_factory=lambda: datetime.now(UTC))


def _clean_headers(headers: httpx.Headers) -> dict[str, str]:
    out: dict[str, str] = {}
    for k, v in headers.items():
        key = k.lower()
        if key in REDACTED_RESPONSE_HEADERS:
            continue
        out[key] = v[:512]
        if len(out) >= MAX_STORED_HEADERS:
            break
    return out


class DeliveryExecutor:
    def __init__(
        self,
        factory: async_sessionmaker[AsyncSession],
        storage: PayloadStorage,
        settings: Settings,
        http: httpx.AsyncClient,
    ) -> None:
        self.factory = factory
        self.storage = storage
        self.settings = settings
        self.http = http
        self.box = SecretBox(settings.fernet_key)
        self.lease = timedelta(seconds=settings.delivery_timeout + 30)

    # ---------- claim ----------

    async def _claim(self, session: AsyncSession, job: DeliveryJob, now: datetime) -> Delivery | Outcome:
        delivery = await session.scalar(
            select(Delivery).where(Delivery.id == job.delivery_id).with_for_update()
        )
        if delivery is None or delivery.status in EventStatus.SETTLED:
            return Outcome.SKIPPED
        if job.attempt_number != delivery.current_attempt + 1:
            return Outcome.SKIPPED  # duplicate or stale message
        if (
            delivery.status == EventStatus.DELIVERING
            and delivery.locked_until
            and delivery.locked_until > now
        ):
            return Outcome.SKIPPED  # another worker holds a live lease
        due = delivery.next_attempt_at
        if due and due > now + timedelta(seconds=1) and delivery.status == EventStatus.RETRYING:
            # arrived early from a coarse delay tier: wait some more
            enqueue_attempt(
                session,
                event_id=delivery.event_id,
                delivery=delivery,
                attempt_number=job.attempt_number,
                not_before=due,
            )
            return Outcome.RESCHEDULED
        delivery.status = EventStatus.DELIVERING
        delivery.locked_until = now + self.lease
        delivery.started_at = delivery.started_at or now
        await self._sync_event_status(session, delivery)
        return delivery

    async def _sync_event_status(self, session: AsyncSession, delivery: Delivery) -> None:
        """An event's status follows its latest execution."""
        latest = await session.scalar(
            select(func.max(Delivery.execution_number)).where(Delivery.event_id == delivery.event_id)
        )
        if latest == delivery.execution_number:
            event = await session.get(Event, delivery.event_id, with_for_update=True)
            if event is not None:
                event.status = delivery.status

    # ---------- send ----------

    async def send(
        self,
        url: str,
        body: bytes,
        *,
        secret: str,
        event_id: uuid.UUID,
        event_type: str,
        delivery_id: uuid.UUID,
        attempt_number: int,
    ) -> AttemptResult:
        allow_private = self.settings.allow_private_destinations
        try:
            parse_destination(
                url, require_https=self.settings.require_https_destinations, allow_private=allow_private
            )
            parts = urlsplit(url)
            host = parts.hostname or ""
            port = parts.port or (443 if parts.scheme == "https" else 80)
            # Re-resolve on every attempt and connect to the vetted IP (DNS rebinding defence).
            addrs = await resolve_destination(host, port, allow_private=allow_private)
        except UnresolvableHost as exc:
            return AttemptResult(error=f"Connection failed: {exc}")
        except DestinationError as exc:
            return AttemptResult(error=f"Destination blocked: {exc}", retryable=False)

        ip = addrs[0]
        ip_host = f"[{ip}]" if ip.version == 6 else str(ip)
        netloc = f"{ip_host}:{parts.port}" if parts.port else ip_host
        pinned = urlunsplit((parts.scheme, netloc, parts.path or "/", parts.query, ""))
        host_header = f"{host}:{parts.port}" if parts.port else host

        timestamp = int(time.time())
        headers = {
            "Host": host_header,
            "Content-Type": "application/json",
            "User-Agent": USER_AGENT,
            "X-Webhook-ID": str(event_id),
            "X-Webhook-Event": event_type,
            "X-Webhook-Timestamp": str(timestamp),
            "X-Webhook-Signature": signature_header(secret, timestamp, body),
            "X-Webhook-Attempt": str(attempt_number),
            "X-Webhook-Delivery": str(delivery_id),
        }
        extensions = {"sni_hostname": host} if parts.scheme == "https" else {}
        request = self.http.build_request(
            "POST", pinned, content=body, headers=headers, extensions=extensions
        )

        started = time.monotonic()
        attempted_at = datetime.now(UTC)
        limit = self.settings.max_response_body_bytes
        try:
            async with asyncio.timeout(self.settings.delivery_timeout):
                response = await self.http.send(request, stream=True, follow_redirects=False)
                try:
                    chunks: list[bytes] = []
                    size = 0
                    truncated = False
                    async for chunk in response.aiter_bytes():  # decoded; stops at the limit
                        chunks.append(chunk)
                        size += len(chunk)
                        if size > limit:
                            truncated = True
                            break
                finally:
                    await response.aclose()
        except TimeoutError, httpx.TimeoutException:
            return AttemptResult(
                error=f"Timed out after {self.settings.delivery_timeout:g}s",
                duration_ms=int((time.monotonic() - started) * 1000),
                attempted_at=attempted_at,
            )
        except httpx.HTTPError as exc:
            return AttemptResult(
                error=f"Connection failed: {type(exc).__name__}",
                duration_ms=int((time.monotonic() - started) * 1000),
                attempted_at=attempted_at,
            )

        raw = b"".join(chunks)[:limit]
        text = raw.decode("utf-8", errors="replace") + ("\n…[truncated]" if truncated else "")
        error = None
        if 300 <= response.status_code < 400:
            error = "Redirects aren’t followed. Point the endpoint at the final URL."
        return AttemptResult(
            http_status=response.status_code,
            body=text,
            headers=_clean_headers(response.headers),
            duration_ms=int((time.monotonic() - started) * 1000),
            error=error,
            retry_after=parse_retry_after(response.headers.get("retry-after")),
            attempted_at=attempted_at,
        )

    # ---------- record ----------

    async def _record(self, job: DeliveryJob, result: AttemptResult) -> Outcome:
        async with self.factory() as session:
            delivery = await session.scalar(
                select(Delivery).where(Delivery.id == job.delivery_id).with_for_update()
            )
            if (
                delivery is None
                or delivery.status != EventStatus.DELIVERING
                or delivery.current_attempt != job.attempt_number - 1
            ):
                return Outcome.SKIPPED  # lease expired and someone else took over
            now = datetime.now(UTC)
            session.add(
                DeliveryAttempt(
                    delivery_id=delivery.id,
                    attempt_number=job.attempt_number,
                    http_status=result.http_status,
                    response_body=result.body,
                    response_headers=result.headers,
                    duration_ms=result.duration_ms,
                    error_message=result.error,
                    attempted_at=result.attempted_at,
                )
            )
            delivery.current_attempt = job.attempt_number
            delivery.locked_until = None

            if is_success(result.http_status):
                delivery.status = EventStatus.DELIVERED
                delivery.next_attempt_at = None
                delivery.completed_at = now
                outcome = Outcome.DELIVERED
            else:
                decision = decide_retry(
                    job.attempt_number,
                    result.http_status,
                    max_attempts=delivery.max_attempts,
                    retry_after=result.retry_after,
                )
                if decision.retry and result.retryable is not False:
                    delivery.status = EventStatus.RETRYING
                    delivery.next_attempt_at = now + timedelta(seconds=decision.delay_seconds)
                    enqueue_attempt(
                        session,
                        event_id=delivery.event_id,
                        delivery=delivery,
                        attempt_number=job.attempt_number + 1,
                        not_before=delivery.next_attempt_at,
                    )
                    outcome = Outcome.RETRY_SCHEDULED
                else:
                    delivery.status = EventStatus.FAILED
                    delivery.next_attempt_at = None
                    delivery.completed_at = now
                    outcome = Outcome.FAILED
            await self._sync_event_status(session, delivery)
            try:
                await session.commit()
            except IntegrityError:
                await session.rollback()
                return Outcome.SKIPPED  # attempt already recorded by a duplicate
            return outcome

    async def _release(self, job: DeliveryJob, reason: str) -> Outcome:
        """Our own failure (e.g. storage outage): give the attempt back without charging it."""
        async with self.factory() as session:
            delivery = await session.scalar(
                select(Delivery).where(Delivery.id == job.delivery_id).with_for_update()
            )
            if delivery is None or delivery.status != EventStatus.DELIVERING:
                return Outcome.SKIPPED
            delivery.status = EventStatus.RETRYING
            delivery.locked_until = None
            delivery.next_attempt_at = datetime.now(UTC) + INTERNAL_RETRY_DELAY
            enqueue_attempt(
                session,
                event_id=delivery.event_id,
                delivery=delivery,
                attempt_number=job.attempt_number,
                not_before=delivery.next_attempt_at,
            )
            await self._sync_event_status(session, delivery)
            await session.commit()
        logger.warning(
            "delivery released after internal error",
            extra={"delivery_id": str(job.delivery_id), "reason": reason},
        )
        return Outcome.RESCHEDULED

    # ---------- entry point ----------

    async def process(self, job: DeliveryJob) -> Outcome:
        async with self.factory() as session:
            claimed = await self._claim(session, job, datetime.now(UTC))
            await session.commit()
            if isinstance(claimed, Outcome):
                return claimed
            delivery = claimed
            event = await session.get(Event, delivery.event_id)
            endpoint = await session.get(Endpoint, event.endpoint_id) if event else None
            if event is None or endpoint is None:
                return Outcome.SKIPPED
            snapshot = {
                "event_id": event.id,
                "event_type": event.event_type,
                "payload_key": event.payload_key,
                "endpoint_id": endpoint.id,
                "url": endpoint.url,
                "enabled": endpoint.enabled,
                "secret": endpoint.signing_secret_encrypted,
            }

        if not snapshot["enabled"]:
            result = AttemptResult(error="Endpoint is disabled, so delivery was stopped.", retryable=False)
        else:
            try:
                body = await self.storage.get(snapshot["payload_key"])
                secret = self.box.decrypt(snapshot["secret"])
            except (StorageError, ValueError) as exc:
                return await self._release(job, type(exc).__name__)
            result = await self.send(
                snapshot["url"],
                body,
                secret=secret,
                event_id=snapshot["event_id"],
                event_type=snapshot["event_type"],
                delivery_id=job.delivery_id,
                attempt_number=job.attempt_number,
            )

        outcome = await self._record(job, result)
        logger.info(
            "delivery attempt",
            extra={
                "event_id": str(snapshot["event_id"]),
                "delivery_id": str(job.delivery_id),
                "endpoint_id": str(snapshot["endpoint_id"]),
                "attempt": job.attempt_number,
                "status": outcome.value,
                "http_status": result.http_status,
                "duration_ms": result.duration_ms,
                "error": result.error,
            },
        )
        return outcome
