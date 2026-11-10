import re
import uuid
from datetime import datetime
from typing import Any

from pydantic import BaseModel, Field, field_validator

EVENT_TYPE_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.:\-]{0,149}$")


class IngestRequest(BaseModel):
    event_type: str = Field(min_length=1, max_length=150)
    data: Any = Field(default_factory=dict)

    @field_validator("event_type")
    @classmethod
    def _type(cls, v: str) -> str:
        if not EVENT_TYPE_RE.match(v):
            raise ValueError("event_type may contain letters, digits, '.', '_', ':' and '-'.")
        return v


class IngestResponse(BaseModel):
    event_id: uuid.UUID
    status: str
    message: str


class EventSummary(BaseModel):
    id: uuid.UUID
    event_type: str
    endpoint_id: uuid.UUID
    endpoint_name: str
    status: str
    attempts: int
    payload_size: int
    idempotency_key: str | None
    created_at: datetime
    # "live", or "demo_fixture" for seeded sample history whose attempts were simulated
    source: str = "live"


class DeliveryOut(BaseModel):
    id: uuid.UUID
    event_id: uuid.UUID
    execution_number: int
    trigger_type: str
    status: str
    current_attempt: int
    max_attempts: int
    next_attempt_at: datetime | None
    started_at: datetime | None
    completed_at: datetime | None
    created_at: datetime
    last_http_status: int | None = None
    last_duration_ms: int | None = None


class EventDetail(EventSummary):
    endpoint_url: str
    endpoint_enabled: bool
    latest_delivery: DeliveryOut | None


class DeliveryDetail(DeliveryOut):
    event_type: str
    endpoint_id: uuid.UUID
    endpoint_name: str
    endpoint_url: str


class AttemptOut(BaseModel):
    id: uuid.UUID
    delivery_id: uuid.UUID
    attempt_number: int
    http_status: int | None
    response_body: str | None
    response_headers: dict[str, str] | None
    duration_ms: int | None
    error_message: str | None
    attempted_at: datetime


class EventFilters(BaseModel):
    status: str | None = None
    event_type: str | None = None
    endpoint_id: uuid.UUID | None = None
    from_: datetime | None = None
    to: datetime | None = None
    search: str | None = None
    sort: str = "-created_at"
