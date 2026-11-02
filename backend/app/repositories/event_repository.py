import uuid
from datetime import datetime

from sqlalchemy import Select, String, cast, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import Delivery, Endpoint, Event


class EventRepository:
    def __init__(self, session: AsyncSession) -> None:
        self.session = session

    def add(self, event: Event) -> None:
        self.session.add(event)

    async def get_owned(self, event_id: uuid.UUID, user_id: uuid.UUID) -> tuple[Event, Endpoint] | None:
        row = (
            await self.session.execute(
                select(Event, Endpoint)
                .join(Endpoint, Endpoint.id == Event.endpoint_id)
                .where(Event.id == event_id, Endpoint.user_id == user_id)
            )
        ).first()
        return (row[0], row[1]) if row else None

    async def find_by_idempotency_key(self, endpoint_id: uuid.UUID, key: str) -> Event | None:
        return await self.session.scalar(
            select(Event).where(Event.endpoint_id == endpoint_id, Event.idempotency_key == key)
        )

    def _filtered(
        self,
        user_id: uuid.UUID,
        *,
        status: str | None,
        event_type: str | None,
        endpoint_id: uuid.UUID | None,
        date_from: datetime | None,
        date_to: datetime | None,
        search: str | None,
    ) -> Select:
        attempts = (
            select(func.coalesce(func.sum(Delivery.current_attempt), 0))
            .where(Delivery.event_id == Event.id)
            .correlate(Event)
            .scalar_subquery()
        )
        stmt = (
            select(Event, Endpoint.name, attempts.label("attempts"))
            .join(Endpoint, Endpoint.id == Event.endpoint_id)
            .where(Endpoint.user_id == user_id)
        )
        if status:
            stmt = stmt.where(Event.status == status)
        if event_type:
            stmt = stmt.where(Event.event_type == event_type)
        if endpoint_id:
            stmt = stmt.where(Event.endpoint_id == endpoint_id)
        if date_from:
            stmt = stmt.where(Event.created_at >= date_from)
        if date_to:
            stmt = stmt.where(Event.created_at <= date_to)
        if search:
            term = search.strip().lower().removeprefix("evt_")
            compact = term.replace("-", "")
            escaped = term.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
            conditions = [Event.event_type.ilike(f"%{escaped}%", escape="\\")]
            if compact and all(c in "0123456789abcdef" for c in compact):
                conditions.append(func.replace(cast(Event.id, String), "-", "").like(f"{compact}%"))
            stmt = stmt.where(or_(*conditions))
        return stmt

    async def list(
        self,
        user_id: uuid.UUID,
        *,
        offset: int,
        limit: int,
        ascending: bool = False,
        **filters,
    ) -> tuple[list[tuple[Event, str, int]], int]:
        stmt = self._filtered(user_id, **filters)
        total = await self.session.scalar(select(func.count()).select_from(stmt.subquery())) or 0
        order = (
            (Event.created_at.asc(), Event.id.asc())
            if ascending
            else (Event.created_at.desc(), Event.id.desc())
        )
        rows = await self.session.execute(stmt.order_by(*order).offset(offset).limit(limit))
        return [(e, name, int(n)) for e, name, n in rows], total

    async def attempt_count(self, event_id: uuid.UUID) -> int:
        return int(
            await self.session.scalar(
                select(func.coalesce(func.sum(Delivery.current_attempt), 0)).where(
                    Delivery.event_id == event_id
                )
            )
            or 0
        )
