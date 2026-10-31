import uuid
from dataclasses import dataclass
from datetime import datetime

from sqlalchemy import case, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import Endpoint, Event, EventStatus


@dataclass(frozen=True)
class EndpointStatsRow:
    total_events: int
    success_rate: float | None
    last_event_at: datetime | None


class EndpointRepository:
    def __init__(self, session: AsyncSession) -> None:
        self.session = session

    def add(self, endpoint: Endpoint) -> None:
        self.session.add(endpoint)

    async def get_owned(self, endpoint_id: uuid.UUID, user_id: uuid.UUID) -> Endpoint | None:
        return await self.session.scalar(
            select(Endpoint).where(Endpoint.id == endpoint_id, Endpoint.user_id == user_id)
        )

    async def get(self, endpoint_id: uuid.UUID) -> Endpoint | None:
        return await self.session.get(Endpoint, endpoint_id)

    async def list_for_user(
        self, user_id: uuid.UUID, *, offset: int, limit: int
    ) -> tuple[list[Endpoint], int]:
        base = select(Endpoint).where(Endpoint.user_id == user_id)
        total = await self.session.scalar(select(func.count()).select_from(base.subquery())) or 0
        rows = await self.session.scalars(
            base.order_by(Endpoint.created_at, Endpoint.id).offset(offset).limit(limit)
        )
        return list(rows), total

    async def stats(self, endpoint_ids: list[uuid.UUID]) -> dict[uuid.UUID, EndpointStatsRow]:
        if not endpoint_ids:
            return {}
        delivered = func.count(case((Event.status == EventStatus.DELIVERED, 1)))
        settled = func.count(case((Event.status.in_(EventStatus.SETTLED), 1)))
        rows = await self.session.execute(
            select(Event.endpoint_id, func.count(), delivered, settled, func.max(Event.created_at))
            .where(Event.endpoint_id.in_(endpoint_ids))
            .group_by(Event.endpoint_id)
        )
        out = {
            ep_id: EndpointStatsRow(total, (ok / done) if done else None, last)
            for ep_id, total, ok, done, last in rows
        }
        empty = EndpointStatsRow(0, None, None)
        return {ep_id: out.get(ep_id, empty) for ep_id in endpoint_ids}

    async def payload_keys(self, endpoint_id: uuid.UUID) -> list[str]:
        return list(
            await self.session.scalars(select(Event.payload_key).where(Event.endpoint_id == endpoint_id))
        )
