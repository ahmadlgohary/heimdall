import uuid

from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import Settings
from app.core.exceptions import NotFound, ValidationFailed
from app.core.security import SecretBox, generate_signing_secret
from app.db.models import Endpoint
from app.repositories.endpoint_repository import EndpointRepository
from app.schemas.endpoint import EndpointCreate, EndpointOut, EndpointStats, EndpointUpdate
from app.services.event_service import EventService
from app.services.storage_service import PayloadStorage
from app.utils.validators import DestinationError, validate_destination


class EndpointService:
    def __init__(self, session: AsyncSession, settings: Settings) -> None:
        self.session = session
        self.settings = settings
        self.endpoints = EndpointRepository(session)
        self.box = SecretBox(settings.fernet_key)

    async def _validate_url(self, url: str) -> str:
        try:
            return await validate_destination(
                url,
                require_https=self.settings.require_https_destinations,
                allow_private=self.settings.allow_private_destinations,
            )
        except DestinationError as exc:
            raise ValidationFailed(
                str(exc), code="INVALID_URL", details=[{"field": "url", "message": str(exc)}]
            ) from exc

    async def get_owned(self, user_id: uuid.UUID, endpoint_id: uuid.UUID) -> Endpoint:
        endpoint = await self.endpoints.get_owned(endpoint_id, user_id)
        if endpoint is None:
            raise NotFound("The requested endpoint does not exist.", code="ENDPOINT_NOT_FOUND")
        return endpoint

    async def with_stats(self, endpoints: list[Endpoint]) -> list[EndpointOut]:
        stats = await self.endpoints.stats([e.id for e in endpoints])
        out = []
        for e in endpoints:
            s = stats[e.id]
            item = EndpointOut.model_validate(e)
            item.stats = EndpointStats(
                total_events=s.total_events, success_rate=s.success_rate, last_event_at=s.last_event_at
            )
            out.append(item)
        return out

    async def list(self, user_id: uuid.UUID, *, offset: int, limit: int) -> tuple[list[EndpointOut], int]:
        rows, total = await self.endpoints.list_for_user(user_id, offset=offset, limit=limit)
        return await self.with_stats(rows), total

    async def create(self, user_id: uuid.UUID, data: EndpointCreate) -> tuple[Endpoint, str]:
        url = await self._validate_url(data.url)
        secret = generate_signing_secret()
        endpoint = Endpoint(
            user_id=user_id,
            name=data.name,
            url=url,
            description=data.description or None,
            enabled=data.enabled,
            signing_secret_encrypted=self.box.encrypt(secret),
        )
        self.endpoints.add(endpoint)
        await self.session.commit()
        return endpoint, secret

    async def update(self, user_id: uuid.UUID, endpoint_id: uuid.UUID, data: EndpointUpdate) -> Endpoint:
        endpoint = await self.get_owned(user_id, endpoint_id)
        changes = data.model_dump(exclude_unset=True)
        if changes.get("url") is not None:
            changes["url"] = await self._validate_url(changes["url"])
        for field in ("name", "url", "enabled"):
            if changes.get(field) is not None:
                setattr(endpoint, field, changes[field])
        if "description" in changes:
            endpoint.description = changes["description"] or None
        await self.session.commit()
        await self.session.refresh(endpoint)
        return endpoint

    async def delete(self, user_id: uuid.UUID, endpoint_id: uuid.UUID) -> list[str]:
        """Delete the endpoint and its history. Returns payload keys to purge from storage."""
        endpoint = await self.get_owned(user_id, endpoint_id)
        keys = await self.endpoints.payload_keys(endpoint.id)
        await self.session.delete(endpoint)
        await self.session.commit()
        return keys

    async def rotate_secret(self, user_id: uuid.UUID, endpoint_id: uuid.UUID) -> str:
        endpoint = await self.get_owned(user_id, endpoint_id)
        secret = generate_signing_secret()
        endpoint.signing_secret_encrypted = self.box.encrypt(secret)
        await self.session.commit()
        return secret

    async def send_test(
        self, user_id: uuid.UUID, endpoint_id: uuid.UUID, storage: PayloadStorage
    ) -> uuid.UUID:
        endpoint = await self.get_owned(user_id, endpoint_id)
        result = await EventService(self.session, storage, self.settings).ingest(
            endpoint,
            event_type="heimdall.test",
            data={"message": "Test event from Heimdall", "endpoint": endpoint.name},
        )
        return result.event.id
