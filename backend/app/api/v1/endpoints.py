import uuid

from fastapi import APIRouter, BackgroundTasks, Depends, status

from app.api.dependencies import CurrentUser, SessionDep, SettingsDep, StorageDep
from app.schemas.common import Page, PageParams, page_params
from app.schemas.endpoint import (
    EndpointCreate,
    EndpointOut,
    EndpointUpdate,
    EndpointWithSecret,
    SecretOut,
    TestEventOut,
)
from app.services.endpoint_service import EndpointService
from app.services.storage_service import PayloadStorage

router = APIRouter(prefix="/endpoints", tags=["endpoints"])


async def _purge(storage: PayloadStorage, keys: list[str]) -> None:
    for key in keys:
        await storage.delete(key)


@router.get("")
async def list_endpoints(
    user: CurrentUser, db: SessionDep, settings: SettingsDep, page: PageParams = Depends(page_params)
) -> Page[EndpointOut]:
    items, total = await EndpointService(db, settings).list(user.id, offset=page.offset, limit=page.limit)
    return Page.build(items, page=page.page, limit=page.limit, total=total)


@router.post("", status_code=status.HTTP_201_CREATED)
async def create_endpoint(
    body: EndpointCreate, user: CurrentUser, db: SessionDep, settings: SettingsDep
) -> EndpointWithSecret:
    endpoint, secret = await EndpointService(db, settings).create(user.id, body)
    return EndpointWithSecret(**EndpointOut.model_validate(endpoint).model_dump(), signing_secret=secret)


@router.get("/{endpoint_id}")
async def get_endpoint(
    endpoint_id: uuid.UUID, user: CurrentUser, db: SessionDep, settings: SettingsDep
) -> EndpointOut:
    service = EndpointService(db, settings)
    endpoint = await service.get_owned(user.id, endpoint_id)
    return (await service.with_stats([endpoint]))[0]


@router.patch("/{endpoint_id}")
async def update_endpoint(
    endpoint_id: uuid.UUID, body: EndpointUpdate, user: CurrentUser, db: SessionDep, settings: SettingsDep
) -> EndpointOut:
    service = EndpointService(db, settings)
    endpoint = await service.update(user.id, endpoint_id, body)
    return (await service.with_stats([endpoint]))[0]


@router.delete("/{endpoint_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_endpoint(
    endpoint_id: uuid.UUID,
    user: CurrentUser,
    db: SessionDep,
    settings: SettingsDep,
    storage: StorageDep,
    background: BackgroundTasks,
) -> None:
    keys = await EndpointService(db, settings).delete(user.id, endpoint_id)
    # only objects under this account's own prefix: demo copies share the template's payloads
    background.add_task(_purge, storage, [k for k in keys if k.startswith(f"events/{user.id}/")])


@router.post("/{endpoint_id}/rotate-secret")
async def rotate_secret(
    endpoint_id: uuid.UUID, user: CurrentUser, db: SessionDep, settings: SettingsDep
) -> SecretOut:
    return SecretOut(signing_secret=await EndpointService(db, settings).rotate_secret(user.id, endpoint_id))


@router.post("/{endpoint_id}/test", status_code=status.HTTP_202_ACCEPTED)
async def send_test_event(
    endpoint_id: uuid.UUID, user: CurrentUser, db: SessionDep, settings: SettingsDep, storage: StorageDep
) -> TestEventOut:
    event_id = await EndpointService(db, settings).send_test(user.id, endpoint_id, storage)
    return TestEventOut(event_id=event_id, status="queued", message="Event accepted for delivery")
