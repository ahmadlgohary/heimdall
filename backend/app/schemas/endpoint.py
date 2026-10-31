import uuid
from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field

from app.schemas.common import ORMModel


class EndpointCreate(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True)

    name: str = Field(min_length=1, max_length=100)
    url: str = Field(min_length=1, max_length=2048)
    description: str | None = Field(default=None, max_length=500)
    enabled: bool = True


class EndpointUpdate(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True)

    name: str | None = Field(default=None, min_length=1, max_length=100)
    url: str | None = Field(default=None, min_length=1, max_length=2048)
    description: str | None = Field(default=None, max_length=500)
    enabled: bool | None = None


class EndpointStats(BaseModel):
    total_events: int
    success_rate: float | None
    last_event_at: datetime | None


class EndpointOut(ORMModel):
    id: uuid.UUID
    name: str
    url: str
    description: str | None
    enabled: bool
    created_at: datetime
    updated_at: datetime
    stats: EndpointStats | None = None


class EndpointWithSecret(EndpointOut):
    signing_secret: str


class SecretOut(BaseModel):
    signing_secret: str


class TestEventOut(BaseModel):
    event_id: uuid.UUID
    status: str
    message: str
