import asyncio
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import Settings
from app.core.exceptions import BadRequest, Conflict, Unauthorized
from app.core.security import (
    DUMMY_PASSWORD_HASH,
    AccessToken,
    create_access_token,
    generate_token,
    hash_password,
    hash_token,
    verify_password,
)
from app.db.models import RefreshToken, User
from app.repositories.user_repository import RefreshTokenRepository, UserRepository


@dataclass(frozen=True)
class Session:
    user: User
    access: AccessToken
    refresh_token: str
    refresh_expires_at: datetime


class AuthService:
    def __init__(self, session: AsyncSession, settings: Settings) -> None:
        self.session = session
        self.settings = settings
        self.users = UserRepository(session)
        self.tokens = RefreshTokenRepository(session)

    async def _issue(self, user: User, family_id: uuid.UUID | None = None) -> tuple[RefreshToken, str]:
        raw = generate_token(48)
        token = RefreshToken(
            user_id=user.id,
            token_hash=hash_token(raw),
            family_id=family_id or uuid.uuid4(),
            expires_at=datetime.now(UTC) + timedelta(days=self.settings.refresh_token_expire_days),
        )
        self.tokens.add(token)
        return token, raw

    async def register(self, email: str, password: str) -> Session:
        if await self.users.get_by_email(email):
            raise Conflict("An account with this email already exists.", code="EMAIL_TAKEN")
        user = User(email=email, password_hash=await asyncio.to_thread(hash_password, password))
        self.users.add(user)
        try:
            await self.session.flush()
        except IntegrityError as exc:
            await self.session.rollback()
            raise Conflict("An account with this email already exists.", code="EMAIL_TAKEN") from exc
        token, raw = await self._issue(user)
        await self.session.commit()
        return Session(user, create_access_token(user.id, self.settings), raw, token.expires_at)

    async def login(self, email: str, password: str) -> Session:
        user = await self.users.get_by_email(email)
        # always run a hash verification so response time doesn't reveal whether the account exists
        ok = await asyncio.to_thread(
            verify_password, password, user.password_hash if user else DUMMY_PASSWORD_HASH
        )
        if not user or not ok:
            raise Unauthorized("Incorrect email or password.", code="INVALID_CREDENTIALS")
        token, raw = await self._issue(user)
        await self.session.commit()
        return Session(user, create_access_token(user.id, self.settings), raw, token.expires_at)

    async def refresh(self, raw_token: str | None) -> Session:
        """Rotate the refresh token. Reusing a rotated token revokes the whole family."""
        if not raw_token:
            raise Unauthorized("Session expired. Sign in again.", code="REFRESH_INVALID")
        now = datetime.now(UTC)
        current = await self.tokens.get_by_hash(hash_token(raw_token), for_update=True)
        if current is None:
            raise Unauthorized("Session expired. Sign in again.", code="REFRESH_INVALID")
        if current.revoked_at is not None:
            # A rotated token came back: likely stolen. Kill every token from that login.
            await self.tokens.revoke_family(current.family_id, now)
            await self.session.commit()
            raise Unauthorized("Session expired. Sign in again.", code="REFRESH_REUSED")
        if current.expires_at <= now:
            raise Unauthorized("Session expired. Sign in again.", code="REFRESH_EXPIRED")
        user = await self.users.get(current.user_id)
        if user is None:
            raise Unauthorized("Session expired. Sign in again.", code="REFRESH_INVALID")
        new_token, raw = await self._issue(user, family_id=current.family_id)
        await self.session.flush()
        current.revoked_at = now
        current.replaced_by_id = new_token.id
        await self.session.commit()
        return Session(user, create_access_token(user.id, self.settings), raw, new_token.expires_at)

    async def logout(self, raw_token: str | None) -> None:
        if not raw_token:
            return
        token = await self.tokens.get_by_hash(hash_token(raw_token))
        if token is not None:
            await self.tokens.revoke_family(token.family_id, datetime.now(UTC))
            await self.session.commit()

    async def change_password(self, user: User, current: str, new: str, raw_refresh: str | None) -> None:
        if not await asyncio.to_thread(verify_password, current, user.password_hash):
            raise BadRequest("Current password is incorrect.", code="INVALID_PASSWORD")
        user.password_hash = await asyncio.to_thread(hash_password, new)
        keep = None
        if raw_refresh:
            token = await self.tokens.get_by_hash(hash_token(raw_refresh))
            if token is not None and token.user_id == user.id:
                keep = token.family_id
        # sign out every other session
        await self.tokens.revoke_all_for_user(user.id, datetime.now(UTC), except_family=keep)
        await self.session.commit()
