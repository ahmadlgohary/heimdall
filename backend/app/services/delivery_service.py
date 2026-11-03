"""Shared delivery helpers: queueing a delivery execution and shaping responses."""

import uuid
from datetime import UTC, datetime

from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import Delivery, DeliveryAttempt, Event, EventStatus, MessageType, OutboxMessage
from app.messaging.messages import DeliveryJob
from app.schemas.event import AttemptOut, DeliveryOut


def queue_delivery(
    session: AsyncSession,
    event: Event,
    *,
    execution_number: int,
    trigger_type: str,
    max_attempts: int,
) -> Delivery:
    """Create a delivery execution and its outbox message in the caller's transaction."""
    delivery = Delivery(
        id=uuid.uuid4(),
        event_id=event.id,
        execution_number=execution_number,
        trigger_type=trigger_type,
        status=EventStatus.QUEUED,
        current_attempt=0,
        max_attempts=max_attempts,
        created_at=datetime.now(UTC),
    )
    session.add(delivery)
    enqueue_attempt(session, event_id=event.id, delivery=delivery, attempt_number=1)
    return delivery


def enqueue_attempt(
    session: AsyncSession,
    *,
    event_id: uuid.UUID,
    delivery: Delivery,
    attempt_number: int,
    not_before: datetime | None = None,
) -> OutboxMessage:
    job = DeliveryJob(delivery_id=delivery.id, attempt_number=attempt_number, not_before=not_before)
    message = OutboxMessage(
        event_id=event_id,
        delivery_id=delivery.id,
        message_type=MessageType.DELIVERY_DISPATCH,
        payload=job.model_dump(mode="json"),
    )
    session.add(message)
    return message


def delivery_out(delivery: Delivery, last_attempt: DeliveryAttempt | None) -> DeliveryOut:
    return DeliveryOut(
        id=delivery.id,
        event_id=delivery.event_id,
        execution_number=delivery.execution_number,
        trigger_type=delivery.trigger_type,
        status=delivery.status,
        current_attempt=delivery.current_attempt,
        max_attempts=delivery.max_attempts,
        next_attempt_at=delivery.next_attempt_at,
        started_at=delivery.started_at,
        completed_at=delivery.completed_at,
        created_at=delivery.created_at,
        last_http_status=last_attempt.http_status if last_attempt else None,
        last_duration_ms=last_attempt.duration_ms if last_attempt else None,
    )


def attempt_out(a: DeliveryAttempt) -> AttemptOut:
    return AttemptOut(
        id=a.id,
        delivery_id=a.delivery_id,
        attempt_number=a.attempt_number,
        http_status=a.http_status,
        response_body=a.response_body,
        response_headers=a.response_headers,
        duration_ms=a.duration_ms,
        error_message=a.error_message,
        attempted_at=a.attempted_at,
    )
