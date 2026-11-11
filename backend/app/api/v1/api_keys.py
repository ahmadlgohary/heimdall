import uuid

from fastapi import APIRouter, Depends, status

from app.api.dependencies import CurrentUser, SessionDep, WritableUser
from app.schemas.api_key import ApiKeyCreate, ApiKeyCreated, ApiKeyOut
from app.schemas.common import Page, PageParams, page_params
from app.services.api_key_service import ApiKeyService

router = APIRouter(prefix="/api-keys", tags=["api keys"])


@router.post("", status_code=status.HTTP_201_CREATED)
async def create_api_key(body: ApiKeyCreate, user: WritableUser, db: SessionDep) -> ApiKeyCreated:
    key, raw = await ApiKeyService(db).create(user.id, body.name)
    return ApiKeyCreated(**ApiKeyOut.model_validate(key).model_dump(), key=raw)


@router.get("")
async def list_api_keys(
    user: CurrentUser, db: SessionDep, page: PageParams = Depends(page_params)
) -> Page[ApiKeyOut]:
    keys, total = await ApiKeyService(db).list(user.id, offset=page.offset, limit=page.limit)
    return Page.build(
        [ApiKeyOut.model_validate(k) for k in keys], page=page.page, limit=page.limit, total=total
    )


@router.delete("/{key_id}", status_code=status.HTTP_204_NO_CONTENT)
async def revoke_api_key(key_id: uuid.UUID, user: WritableUser, db: SessionDep) -> None:
    await ApiKeyService(db).revoke(user.id, key_id)
