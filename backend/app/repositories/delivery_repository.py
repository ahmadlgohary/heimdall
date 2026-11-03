import uuid

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import Delivery, DeliveryAttempt, Endpoint, Event


class DeliveryRepository:
    def __init__(self, session: AsyncSession) -> None:
        self.session = session

    def add(self, delivery: Delivery) -> None:
        self.session.add(delivery)

    async def get_owned(
        self, delivery_id: uuid.UUID, user_id: uuid.UUID
    ) -> tuple[Delivery, Event, Endpoint] | None:
        row = (
            await self.session.execute(
                select(Delivery, Event, Endpoint)
                .join(Event, Event.id == Delivery.event_id)
                .join(Endpoint, Endpoint.id == Event.endpoint_id)
                .where(Delivery.id == delivery_id, Endpoint.user_id == user_id)
            )
        ).first()
        return (row[0], row[1], row[2]) if row else None

    async def for_event(self, event_id: uuid.UUID) -> list[Delivery]:
        rows = await self.session.scalars(
            select(Delivery).where(Delivery.event_id == event_id).order_by(Delivery.execution_number.desc())
        )
        return list(rows)

    async def latest_for_events(self, event_ids: list[uuid.UUID]) -> dict[uuid.UUID, Delivery]:
        if not event_ids:
            return {}
        ranked = (
            select(
                Delivery.id,
                func.row_number()
                .over(partition_by=Delivery.event_id, order_by=Delivery.execution_number.desc())
                .label("rn"),
            )
            .where(Delivery.event_id.in_(event_ids))
            .subquery()
        )
        rows = await self.session.scalars(
            select(Delivery).join(ranked, ranked.c.id == Delivery.id).where(ranked.c.rn == 1)
        )
        return {d.event_id: d for d in rows}

    async def next_execution_number(self, event_id: uuid.UUID) -> int:
        current = await self.session.scalar(
            select(func.max(Delivery.execution_number)).where(Delivery.event_id == event_id)
        )
        return (current or 0) + 1

    async def attempts(self, delivery_id: uuid.UUID, *, offset: int = 0, limit: int = 100):
        base = select(DeliveryAttempt).where(DeliveryAttempt.delivery_id == delivery_id)
        total = await self.session.scalar(select(func.count()).select_from(base.subquery())) or 0
        rows = await self.session.scalars(
            base.order_by(DeliveryAttempt.attempt_number).offset(offset).limit(limit)
        )
        return list(rows), total

    async def last_attempts(self, delivery_ids: list[uuid.UUID]) -> dict[uuid.UUID, DeliveryAttempt]:
        if not delivery_ids:
            return {}
        ranked = (
            select(
                DeliveryAttempt.id,
                func.row_number()
                .over(
                    partition_by=DeliveryAttempt.delivery_id, order_by=DeliveryAttempt.attempt_number.desc()
                )
                .label("rn"),
            )
            .where(DeliveryAttempt.delivery_id.in_(delivery_ids))
            .subquery()
        )
        rows = await self.session.scalars(
            select(DeliveryAttempt).join(ranked, ranked.c.id == DeliveryAttempt.id).where(ranked.c.rn == 1)
        )
        return {a.delivery_id: a for a in rows}
