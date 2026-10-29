from typing import Annotated

from fastapi import Query
from pydantic import BaseModel, ConfigDict

MAX_PAGE_SIZE = 100


class ORMModel(BaseModel):
    model_config = ConfigDict(from_attributes=True)


class PaginationMeta(BaseModel):
    page: int
    limit: int
    total: int
    total_pages: int


class Page[T](BaseModel):
    items: list[T]
    pagination: PaginationMeta

    @classmethod
    def build(cls, items: list[T], *, page: int, limit: int, total: int) -> Page[T]:
        return cls(
            items=items,
            pagination=PaginationMeta(page=page, limit=limit, total=total, total_pages=-(-total // limit)),
        )


class PageParams(BaseModel):
    page: int
    limit: int

    @property
    def offset(self) -> int:
        return (self.page - 1) * self.limit


def page_params(
    page: Annotated[int, Query(ge=1)] = 1,
    limit: Annotated[int, Query(ge=1, le=MAX_PAGE_SIZE)] = 20,
) -> PageParams:
    return PageParams(page=page, limit=limit)
