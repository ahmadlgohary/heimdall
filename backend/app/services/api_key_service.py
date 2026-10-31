import uuid
from datetime import UTC, datetime, timedelta

from sqlalchemy.ext.asyncio import AsyncSession

from app.core.exceptions import NotFound, Unauthorized
from app.core.security import API_KEY_PREFIX, generate_api_key, hash_token
from app.db.models import ApiKey
from app.repositories.api_key_repository import ApiKeyRepository

LAST_USED_GRANULARITY = timedelta(minutes=1)


class ApiKeyService:
    def __init__(self, session: AsyncSession) -> None:
        self.session = session
        self.keys = ApiKeyRepository(session)

    async def create(self, user_id: uuid.UUID, name: str) -> tuple[ApiKey, str]:
        generated = generate_api_key()
        key = ApiKey(user_id=user_id, name=name, key_prefix=generated.prefix, key_hash=generated.hash)
        self.keys.add(key)
        await self.session.commit()
        return key, generated.raw

    async def list(self, user_id: uuid.UUID, *, offset: int, limit: int):
        return await self.keys.list_for_user(user_id, offset=offset, limit=limit)

    async def revoke(self, user_id: uuid.UUID, key_id: uuid.UUID) -> None:
        key = await self.keys.get_owned(key_id, user_id)
        if key is None:
            raise NotFound("The requested API key does not exist.", code="API_KEY_NOT_FOUND")
        if key.revoked_at is None:
            key.revoked_at = datetime.now(UTC)
            await self.session.commit()

    async def authenticate(self, authorization: str | None) -> ApiKey:
        """Resolve `Authorization: Bearer wh_live_...` to an active key."""
        scheme, _, raw = (authorization or "").partition(" ")
        raw = raw.strip()
        if scheme.lower() != "bearer" or not raw:
            raise Unauthorized(
                "Missing API key. Send it as `Authorization: Bearer <key>`.", code="API_KEY_MISSING"
            )
        if not raw.startswith(API_KEY_PREFIX):
            raise Unauthorized("Invalid API key.", code="API_KEY_INVALID")
        key = await self.keys.get_active_by_hash(raw[:12], hash_token(raw))
        if key is None:
            raise Unauthorized("Invalid API key.", code="API_KEY_INVALID")
        now = datetime.now(UTC)
        if key.last_used_at is None or now - key.last_used_at > LAST_USED_GRANULARITY:
            key.last_used_at = now  # committed with the ingestion transaction
        return key
