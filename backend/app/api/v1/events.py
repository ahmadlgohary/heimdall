import uuid
from datetime import datetime
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, Query, Response, status

from app.api.dependencies import CurrentUser, SessionDep, SettingsDep, StorageDep
from app.schemas.common import Page, PageParams, page_params
from app.schemas.event import DeliveryOut, EventDetail, EventSummary
from app.services.event_service import EventService

router = APIRouter(prefix="/events", tags=["events"])

StatusFilter = Literal["queued", "delivering", "retrying", "delivered", "failed"]


@router.get("")
async def list_events(
    user: CurrentUser,
    db: SessionDep,
    storage: StorageDep,
    settings: SettingsDep,
    page: PageParams = Depends(page_params),
    status_: Annotated[StatusFilter | None, Query(alias="status")] = None,
    event_type: Annotated[str | None, Query(max_length=150)] = None,
    endpoint_id: uuid.UUID | None = None,
    date_from: Annotated[datetime | None, Query(alias="from")] = None,
    date_to: Annotated[datetime | None, Query(alias="to")] = None,
    search: Annotated[str | None, Query(max_length=200)] = None,
    sort: Literal["created_at", "-created_at"] = "-created_at",
) -> Page[EventSummary]:
    items, total = await EventService(db, storage, settings).list(
        user.id,
        offset=page.offset,
        limit=page.limit,
        ascending=sort == "created_at",
        status=status_,
        event_type=event_type,
        endpoint_id=endpoint_id,
        date_from=date_from,
        date_to=date_to,
        search=search,
    )
    return Page.build(items, page=page.page, limit=page.limit, total=total)


@router.get("/{event_id}")
async def get_event(
    event_id: uuid.UUID, user: CurrentUser, db: SessionDep, storage: StorageDep, settings: SettingsDep
) -> EventDetail:
    return await EventService(db, storage, settings).detail(user.id, event_id)


@router.get(
    "/{event_id}/payload", response_class=Response, responses={200: {"content": {"application/json": {}}}}
)
async def get_payload(
    event_id: uuid.UUID, user: CurrentUser, db: SessionDep, storage: StorageDep, settings: SettingsDep
) -> Response:
    body = await EventService(db, storage, settings).payload(user.id, event_id)
    return Response(
        content=body, media_type="application/json", headers={"Cache-Control": "private, no-store"}
    )


@router.get("/{event_id}/deliveries")
async def list_deliveries(
    event_id: uuid.UUID,
    user: CurrentUser,
    db: SessionDep,
    storage: StorageDep,
    settings: SettingsDep,
    page: PageParams = Depends(page_params),
) -> Page[DeliveryOut]:
    items = await EventService(db, storage, settings).deliveries_for(user.id, event_id)
    return Page.build(
        items[page.offset : page.offset + page.limit], page=page.page, limit=page.limit, total=len(items)
    )


@router.post("/{event_id}/replay", status_code=status.HTTP_202_ACCEPTED)
async def replay_event(
    event_id: uuid.UUID, user: CurrentUser, db: SessionDep, storage: StorageDep, settings: SettingsDep
) -> DeliveryOut:
    return await EventService(db, storage, settings).replay(user.id, event_id)
