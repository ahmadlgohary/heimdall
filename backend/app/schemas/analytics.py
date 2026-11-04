import uuid
from datetime import datetime
from typing import Literal

from pydantic import BaseModel

TimeRange = Literal["24h", "7d", "30d"]
FailureReason = Literal["http_5xx", "http_4xx", "http_3xx", "http_429", "timeout", "connection"]


class SeriesPoint(BaseModel):
    bucket: datetime
    total: int
    delivered: int
    failed: int
    avg_ms: int | None
    p95_ms: int | None


class DashboardStats(BaseModel):
    range: TimeRange
    total_events: int
    successful_deliveries: int
    failed_deliveries: int
    success_rate: float | None
    avg_response_ms: int | None
    series: list[SeriesPoint]


class ActivityItem(BaseModel):
    event_id: uuid.UUID
    delivery_id: uuid.UUID | None
    event_type: str
    endpoint_id: uuid.UUID
    endpoint_name: str
    status: str
    http_status: int | None
    duration_ms: int | None
    created_at: datetime


class DashboardActivity(BaseModel):
    items: list[ActivityItem]


class FailureCount(BaseModel):
    reason: FailureReason
    count: int


class TopEndpoint(BaseModel):
    endpoint_id: uuid.UUID
    name: str
    total: int
    success_rate: float | None


class FailedEventType(BaseModel):
    event_type: str
    count: int


class AnalyticsOverview(BaseModel):
    range: TimeRange
    total_events: int
    success_rate: float | None
    avg_latency_ms: int | None
    p95_latency_ms: int | None
    series: list[SeriesPoint]
    failure_distribution: list[FailureCount]
    top_endpoints: list[TopEndpoint]
    top_failed_event_types: list[FailedEventType]
