"""Event ingestion — the API developers integrate with (plan §3.4, §7)."""

import json
import uuid
from typing import Annotated

from fastapi import APIRouter, Header, Request, Response, status
from pydantic import ValidationError

from app.api.dependencies import SessionDep, SettingsDep, StorageDep
from app.core.config import Settings
from app.core.exceptions import BadRequest, NotFound, PayloadTooLarge, Unauthorized, ValidationFailed
from app.core.rate_limit import limiter
from app.core.security import constant_time_equals
from app.repositories.endpoint_repository import EndpointRepository
from app.schemas.event import IngestRequest, IngestResponse
from app.services.api_key_service import ApiKeyService
from app.services.event_service import EventService

router = APIRouter(tags=["ingestion"])

IdempotencyKey = Annotated[str | None, Header(alias="Idempotency-Key", max_length=255)]


async def _read_body(request: Request, limit: int) -> bytes:
    declared = request.headers.get("content-length")
    if declared and declared.isdigit() and int(declared) > limit:
        raise PayloadTooLarge(f"Payload exceeds the {limit // 1024} KB limit.")
    body = bytearray()
    async for chunk in request.stream():
        body.extend(chunk)
        if len(body) > limit:
            raise PayloadTooLarge(f"Payload exceeds the {limit // 1024} KB limit.")
    return bytes(body)


def _parse(raw: bytes, content_type: str | None) -> IngestRequest:
    if not content_type or content_type.split(";")[0].strip().lower() != "application/json":
        raise BadRequest(
            "Content-Type must be application/json.", code="UNSUPPORTED_MEDIA_TYPE", status_code=415
        )
    try:
        payload = json.loads(raw)
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise BadRequest("Request body isn't valid JSON.", code="INVALID_JSON") from exc
    try:
        return IngestRequest.model_validate(payload)
    except ValidationError as exc:
        details = [{"field": ".".join(map(str, e["loc"])), "message": e["msg"]} for e in exc.errors()]
        message = f"{details[0]['field']}: {details[0]['message']}" if details else "Invalid event."
        raise ValidationFailed(message, details=details) from exc


async def _ingest(
    endpoint_id: uuid.UUID,
    request: Request,
    response: Response,
    db,
    storage,
    settings: Settings,
    authorization: str | None,
    idempotency_key: str | None,
) -> IngestResponse:
    raw = await _read_body(request, settings.max_payload_bytes)
    key = await ApiKeyService(db).authenticate(authorization)
    limiter.check(f"ingest:{key.id}", settings.ingest_rate_limit_per_minute)
    body = _parse(raw, request.headers.get("content-type"))

    endpoint = await EndpointRepository(db).get_owned(endpoint_id, key.user_id)
    if endpoint is None:
        raise NotFound("The requested endpoint does not exist.", code="ENDPOINT_NOT_FOUND")
    result = await EventService(db, storage, settings).ingest(
        endpoint, event_type=body.event_type, data=body.data, idempotency_key=idempotency_key or None
    )
    if not result.created:
        response.status_code = status.HTTP_200_OK
        response.headers["Idempotent-Replayed"] = "true"
        return IngestResponse(
            event_id=result.event.id,
            status=result.event.status,
            message="Event already accepted for this Idempotency-Key",
        )
    return IngestResponse(
        event_id=result.event.id, status=result.event.status, message="Event accepted for delivery"
    )


@router.post("/ingest/{endpoint_id}", status_code=status.HTTP_202_ACCEPTED)
async def ingest(
    endpoint_id: uuid.UUID,
    request: Request,
    response: Response,
    db: SessionDep,
    storage: StorageDep,
    settings: SettingsDep,
    authorization: Annotated[str | None, Header()] = None,
    idempotency_key: IdempotencyKey = None,
) -> IngestResponse:
    return await _ingest(
        endpoint_id, request, response, db, storage, settings, authorization, idempotency_key
    )


@router.post("/internal/ingest/{endpoint_id}", status_code=status.HTTP_202_ACCEPTED, include_in_schema=False)
async def internal_ingest(
    endpoint_id: uuid.UUID,
    request: Request,
    response: Response,
    db: SessionDep,
    storage: StorageDep,
    settings: SettingsDep,
    authorization: Annotated[str | None, Header()] = None,
    idempotency_key: IdempotencyKey = None,
    worker_secret: Annotated[str | None, Header(alias="X-Worker-Secret")] = None,
) -> IngestResponse:
    """Called only by the Cloudflare Worker, which forwards the caller's API key."""
    if not settings.worker_shared_secret:
        raise NotFound("Not found.")
    if not worker_secret or not constant_time_equals(worker_secret, settings.worker_shared_secret):
        raise Unauthorized("Invalid worker credentials.", code="WORKER_UNAUTHORIZED")
    return await _ingest(
        endpoint_id, request, response, db, storage, settings, authorization, idempotency_key
    )
