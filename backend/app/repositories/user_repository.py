import uuid
from datetime import datetime

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import RefreshToken, User


class UserRepository:
    def __init__(self, session: AsyncSession) -> None:
        self.session = session

    async def get(self, user_id: uuid.UUID) -> User | None:
        return await self.session.get(User, user_id)

    async def get_by_email(self, email: str) -> User | None:
        return await self.session.scalar(select(User).where(User.email == email.lower()))

    def add(self, user: User) -> None:
        self.session.add(user)


class RefreshTokenRepository:
    def __init__(self, session: AsyncSession) -> None:
        self.session = session

    async def get_by_hash(self, token_hash: str, *, for_update: bool = False) -> RefreshToken | None:
        stmt = select(RefreshToken).where(RefreshToken.token_hash == token_hash)
        if for_update:
            stmt = stmt.with_for_update()
        return await self.session.scalar(stmt)

    def add(self, token: RefreshToken) -> None:
        self.session.add(token)

    async def revoke_family(self, family_id: uuid.UUID, now: datetime) -> None:
        await self.session.execute(
            update(RefreshToken)
            .where(RefreshToken.family_id == family_id, RefreshToken.revoked_at.is_(None))
            .values(revoked_at=now)
        )

    async def revoke_all_for_user(
        self, user_id: uuid.UUID, now: datetime, *, except_family: uuid.UUID | None = None
    ):
        stmt = update(RefreshToken).where(RefreshToken.user_id == user_id, RefreshToken.revoked_at.is_(None))
        if except_family is not None:
            stmt = stmt.where(RefreshToken.family_id != except_family)
        await self.session.execute(stmt.values(revoked_at=now))
