import uuid

from fastapi import APIRouter, Depends

from app.api.dependencies import CurrentUser, SessionDep
from app.core.exceptions import NotFound
from app.repositories.delivery_repository import DeliveryRepository
from app.schemas.common import Page, PageParams, page_params
from app.schemas.event import AttemptOut, DeliveryDetail
from app.services.delivery_service import attempt_out, delivery_out

router = APIRouter(prefix="/deliveries", tags=["deliveries"])


async def _owned(repo: DeliveryRepository, delivery_id: uuid.UUID, user_id: uuid.UUID):
    found = await repo.get_owned(delivery_id, user_id)
    if found is None:
        raise NotFound("The requested delivery does not exist.", code="DELIVERY_NOT_FOUND")
    return found


@router.get("/{delivery_id}")
async def get_delivery(delivery_id: uuid.UUID, user: CurrentUser, db: SessionDep) -> DeliveryDetail:
    repo = DeliveryRepository(db)
    delivery, event, endpoint = await _owned(repo, delivery_id, user.id)
    last = (await repo.last_attempts([delivery.id])).get(delivery.id)
    return DeliveryDetail(
        **delivery_out(delivery, last).model_dump(),
        event_type=event.event_type,
        endpoint_id=endpoint.id,
        endpoint_name=endpoint.name,
        endpoint_url=endpoint.url,
    )


@router.get("/{delivery_id}/attempts")
async def list_attempts(
    delivery_id: uuid.UUID, user: CurrentUser, db: SessionDep, page: PageParams = Depends(page_params)
) -> Page[AttemptOut]:
    repo = DeliveryRepository(db)
    await _owned(repo, delivery_id, user.id)
    attempts, total = await repo.attempts(delivery_id, offset=page.offset, limit=page.limit)
    return Page.build([attempt_out(a) for a in attempts], page=page.page, limit=page.limit, total=total)
