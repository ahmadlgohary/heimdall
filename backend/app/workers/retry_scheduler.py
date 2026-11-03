"""Safety net for lost messages: re-enqueue deliveries that should have run but didn't.

A delivery can stall if its broker message is lost (broker data loss, a
message dead-lettered by mistake). This sweep makes sure failed or pending
deliveries never silently disappear (plan §1.3).
"""

import logging
from datetime import UTC, datetime, timedelta

from sqlalchemy import and_, exists, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import Delivery, EventStatus, OutboxMessage
from app.services.delivery_service import enqueue_attempt

logger = logging.getLogger(__name__)

GRACE = timedelta(minutes=2)
COOLDOWN = timedelta(minutes=5)
BATCH = 200


async def requeue_stalled(session: AsyncSession, now: datetime | None = None) -> int:
    now = now or datetime.now(UTC)
    recent_outbox = exists().where(
        OutboxMessage.delivery_id == Delivery.id, OutboxMessage.created_at > now - COOLDOWN
    )
    stalled = await session.scalars(
        select(Delivery)
        .where(
            or_(
                and_(Delivery.status == EventStatus.RETRYING, Delivery.next_attempt_at < now - GRACE),
                and_(Delivery.status == EventStatus.QUEUED, Delivery.created_at < now - GRACE),
                and_(Delivery.status == EventStatus.DELIVERING, Delivery.locked_until < now - GRACE),
            ),
            ~recent_outbox,
        )
        .limit(BATCH)
        .with_for_update(skip_locked=True)
    )
    count = 0
    for delivery in stalled:
        enqueue_attempt(
            session,
            event_id=delivery.event_id,
            delivery=delivery,
            attempt_number=delivery.current_attempt + 1,
        )
        count += 1
        logger.warning(
            "requeued stalled delivery",
            extra={
                "delivery_id": str(delivery.id),
                "status": delivery.status,
                "attempt": delivery.current_attempt + 1,
            },
        )
    await session.commit()
    return count
