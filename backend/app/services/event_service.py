import hashlib
import json
import logging
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import Settings
from app.core.exceptions import Conflict, NotFound
from app.db.models import Endpoint, Event, EventStatus, TriggerType
from app.repositories.delivery_repository import DeliveryRepository
from app.repositories.event_repository import EventRepository
from app.schemas.event import DeliveryOut, EventDetail, EventSummary
from app.services.delivery_service import delivery_out, queue_delivery
from app.services.storage_service import PayloadStorage, StorageError, payload_key

logger = logging.getLogger(__name__)


def request_fingerprint(event_type: str, data: Any) -> str:
    """Stable hash of what was submitted, independent of JSON whitespace/key order."""
    canonical = json.dumps({"event_type": event_type, "data": data}, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(canonical.encode()).hexdigest()


def build_envelope(event_id: uuid.UUID, event_type: str, created_at: datetime, data: Any) -> bytes:
    """The exact bytes stored in object storage, sent to the receiver, and signed."""
    envelope = {
        "id": str(event_id),
        "type": event_type,
        "created_at": created_at.isoformat().replace("+00:00", "Z"),
        "data": data,
    }
    return json.dumps(envelope, separators=(",", ":"), ensure_ascii=False).encode()


@dataclass(frozen=True)
class IngestResult:
    event: Event
    created: bool


class EventService:
    def __init__(self, session: AsyncSession, storage: PayloadStorage, settings: Settings) -> None:
        self.session = session
        self.storage = storage
        self.settings = settings
        self.events = EventRepository(session)
        self.deliveries = DeliveryRepository(session)

    # ---------- ingestion ----------

    async def _existing(self, endpoint_id: uuid.UUID, key: str, fingerprint: str) -> IngestResult | None:
        existing = await self.events.find_by_idempotency_key(endpoint_id, key)
        if existing is None:
            return None
        if existing.payload_hash != fingerprint:
            raise Conflict(
                "This Idempotency-Key was already used with a different payload.",
                code="IDEMPOTENCY_CONFLICT",
                details={"event_id": str(existing.id)},
            )
        return IngestResult(existing, created=False)

    async def ingest(
        self,
        endpoint: Endpoint,
        *,
        event_type: str,
        data: Any,
        idempotency_key: str | None = None,
    ) -> IngestResult:
        """Archive the payload, then persist event + delivery + outbox atomically.

        If storage fails nothing is written; if the database write fails the
        archived object is removed. Returns only once the event is durable.
        """
        if not endpoint.enabled:
            raise Conflict("This endpoint is disabled and isn't accepting events.", code="ENDPOINT_DISABLED")
        fingerprint = request_fingerprint(event_type, data)
        if idempotency_key:
            found = await self._existing(endpoint.id, idempotency_key, fingerprint)
            if found:
                return found

        event_id = uuid.uuid4()
        created_at = datetime.now(UTC)
        body = build_envelope(event_id, event_type, created_at, data)
        key = payload_key(endpoint.user_id, endpoint.id, event_id)
        await self.storage.put(key, body)  # raises StorageError -> 502, nothing persisted

        try:
            event = Event(
                id=event_id,
                endpoint_id=endpoint.id,
                event_type=event_type,
                payload_key=key,
                payload_size=len(body),
                payload_hash=fingerprint,
                idempotency_key=idempotency_key,
                status=EventStatus.QUEUED,
                created_at=created_at,
            )
            self.events.add(event)
            queue_delivery(
                self.session,
                event,
                execution_number=1,
                trigger_type=TriggerType.AUTOMATIC,
                max_attempts=self.settings.max_attempts,
            )
            await self.session.commit()
        except IntegrityError:
            # Concurrent request with the same Idempotency-Key won the race.
            await self.session.rollback()
            await self.storage.delete(key)
            if idempotency_key:
                found = await self._existing(endpoint.id, idempotency_key, fingerprint)
                if found:
                    return found
            raise
        except BaseException:
            # Nothing was committed: don't leave an orphaned payload behind.
            await self.session.rollback()
            await self.storage.delete(key)
            raise
        logger.info(
            "event accepted",
            extra={"event_id": str(event_id), "endpoint_id": str(endpoint.id), "event_type": event_type},
        )
        return IngestResult(event, created=True)

    # ---------- reads ----------

    async def list(self, user_id: uuid.UUID, *, offset: int, limit: int, ascending: bool, **filters):
        rows, total = await self.events.list(
            user_id, offset=offset, limit=limit, ascending=ascending, **filters
        )
        items = [
            EventSummary(
                id=e.id,
                event_type=e.event_type,
                endpoint_id=e.endpoint_id,
                endpoint_name=name,
                status=e.status,
                attempts=attempts,
                payload_size=e.payload_size,
                idempotency_key=e.idempotency_key,
                created_at=e.created_at,
                source=e.source,
            )
            for e, name, attempts in rows
        ]
        return items, total

    async def _owned(self, user_id: uuid.UUID, event_id: uuid.UUID) -> tuple[Event, Endpoint]:
        found = await self.events.get_owned(event_id, user_id)
        if found is None:
            raise NotFound("The requested event does not exist.", code="EVENT_NOT_FOUND")
        return found

    async def detail(self, user_id: uuid.UUID, event_id: uuid.UUID) -> EventDetail:
        event, endpoint = await self._owned(user_id, event_id)
        latest = (await self.deliveries.latest_for_events([event.id])).get(event.id)
        last = (await self.deliveries.last_attempts([latest.id])).get(latest.id) if latest else None
        return EventDetail(
            id=event.id,
            event_type=event.event_type,
            endpoint_id=endpoint.id,
            endpoint_name=endpoint.name,
            status=event.status,
            attempts=await self.events.attempt_count(event.id),
            payload_size=event.payload_size,
            idempotency_key=event.idempotency_key,
            created_at=event.created_at,
            source=event.source,
            endpoint_url=endpoint.url,
            endpoint_enabled=endpoint.enabled,
            latest_delivery=delivery_out(latest, last) if latest else None,
        )

    async def payload(self, user_id: uuid.UUID, event_id: uuid.UUID) -> bytes:
        event, _ = await self._owned(user_id, event_id)
        return await self.storage.get(event.payload_key)

    async def deliveries_for(self, user_id: uuid.UUID, event_id: uuid.UUID) -> list[DeliveryOut]:
        event, _ = await self._owned(user_id, event_id)
        deliveries = await self.deliveries.for_event(event.id)
        last = await self.deliveries.last_attempts([d.id for d in deliveries])
        return [delivery_out(d, last.get(d.id)) for d in deliveries]

    # ---------- replay ----------

    async def replay(self, user_id: uuid.UUID, event_id: uuid.UUID) -> DeliveryOut:
        """New manual execution with the original event id and payload; history is kept."""
        event, endpoint = await self._owned(user_id, event_id)
        if not endpoint.enabled:
            raise Conflict("Enable the endpoint before replaying events.", code="ENDPOINT_DISABLED")
        latest = (await self.deliveries.latest_for_events([event.id])).get(event.id)
        if latest is not None and latest.status not in EventStatus.SETTLED:
            raise Conflict(
                "This event is still being delivered. Replay it once delivery finishes.",
                code="DELIVERY_IN_PROGRESS",
            )
        try:
            await self.storage.get(event.payload_key)
        except StorageError as exc:
            raise StorageError(
                "The original payload is unavailable, so the event can't be replayed."
            ) from exc

        delivery = queue_delivery(
            self.session,
            event,
            execution_number=await self.deliveries.next_execution_number(event.id),
            trigger_type=TriggerType.MANUAL,
            max_attempts=self.settings.max_attempts,
        )
        event.status = EventStatus.QUEUED
        try:
            await self.session.commit()
        except IntegrityError as exc:  # two replays raced for the same execution number
            await self.session.rollback()
            raise Conflict("A replay was just started for this event.", code="DELIVERY_IN_PROGRESS") from exc
        logger.info("event replay queued", extra={"event_id": str(event.id), "delivery_id": str(delivery.id)})
        return delivery_out(delivery, None)
