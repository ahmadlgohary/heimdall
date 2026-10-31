import uuid

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import ApiKey


class ApiKeyRepository:
    def __init__(self, session: AsyncSession) -> None:
        self.session = session

    def add(self, key: ApiKey) -> None:
        self.session.add(key)

    async def get_owned(self, key_id: uuid.UUID, user_id: uuid.UUID) -> ApiKey | None:
        return await self.session.scalar(select(ApiKey).where(ApiKey.id == key_id, ApiKey.user_id == user_id))

    async def get_active_by_hash(self, prefix: str, key_hash: str) -> ApiKey | None:
        return await self.session.scalar(
            select(ApiKey).where(
                ApiKey.key_prefix == prefix, ApiKey.key_hash == key_hash, ApiKey.revoked_at.is_(None)
            )
        )

    async def list_for_user(self, user_id: uuid.UUID, *, offset: int, limit: int) -> tuple[list[ApiKey], int]:
        base = select(ApiKey).where(ApiKey.user_id == user_id)
        total = await self.session.scalar(select(func.count()).select_from(base.subquery())) or 0
        rows = await self.session.scalars(base.order_by(ApiKey.created_at.desc()).offset(offset).limit(limit))
        return list(rows), total
