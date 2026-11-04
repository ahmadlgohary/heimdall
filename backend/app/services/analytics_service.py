"""Dashboard and analytics aggregates, computed in PostgreSQL (plan §8.4)."""

import uuid
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import Endpoint, Event
from app.repositories.delivery_repository import DeliveryRepository
from app.schemas.analytics import (
    ActivityItem,
    AnalyticsOverview,
    DashboardStats,
    FailedEventType,
    FailureCount,
    SeriesPoint,
    TimeRange,
    TopEndpoint,
)

RANGE: dict[str, timedelta] = {"24h": timedelta(hours=24), "7d": timedelta(days=7), "30d": timedelta(days=30)}
STEP: dict[str, timedelta] = {"24h": timedelta(hours=1), "7d": timedelta(hours=12), "30d": timedelta(days=1)}

# Every query is scoped to the user through endpoints.user_id.
_EVENT_SERIES = text("""
    SELECT date_bin(:step, e.created_at, :origin) AS bucket,
           count(*) AS total,
           count(*) FILTER (WHERE e.status = 'delivered') AS delivered,
           count(*) FILTER (WHERE e.status = 'failed') AS failed
    FROM events e JOIN endpoints ep ON ep.id = e.endpoint_id
    WHERE ep.user_id = :uid AND e.created_at >= :start AND e.created_at < :end
    GROUP BY 1
""")

_LATENCY_SERIES = text("""
    SELECT date_bin(:step, a.attempted_at, :origin) AS bucket,
           avg(a.duration_ms) AS avg_ms,
           percentile_cont(0.95) WITHIN GROUP (ORDER BY a.duration_ms) AS p95_ms
    FROM delivery_attempts a
    JOIN deliveries d ON d.id = a.delivery_id
    JOIN events e ON e.id = d.event_id
    JOIN endpoints ep ON ep.id = e.endpoint_id
    WHERE ep.user_id = :uid AND a.attempted_at >= :start AND a.attempted_at < :end
      AND a.http_status IS NOT NULL AND a.duration_ms IS NOT NULL
    GROUP BY 1
""")

_LATENCY_TOTAL = text("""
    SELECT avg(a.duration_ms), percentile_cont(0.95) WITHIN GROUP (ORDER BY a.duration_ms)
    FROM delivery_attempts a
    JOIN deliveries d ON d.id = a.delivery_id
    JOIN events e ON e.id = d.event_id
    JOIN endpoints ep ON ep.id = e.endpoint_id
    WHERE ep.user_id = :uid AND a.attempted_at >= :start AND a.attempted_at < :end
      AND a.http_status IS NOT NULL AND a.duration_ms IS NOT NULL
""")

_FAILURES = text("""
    SELECT CASE
             WHEN a.http_status IS NULL AND a.error_message ILIKE 'timed out%' THEN 'timeout'
             WHEN a.http_status IS NULL THEN 'connection'
             WHEN a.http_status = 429 THEN 'http_429'
             WHEN a.http_status >= 500 THEN 'http_5xx'
             WHEN a.http_status >= 400 THEN 'http_4xx'
             ELSE 'http_3xx'
           END AS reason,
           count(*)
    FROM delivery_attempts a
    JOIN deliveries d ON d.id = a.delivery_id
    JOIN events e ON e.id = d.event_id
    JOIN endpoints ep ON ep.id = e.endpoint_id
    WHERE ep.user_id = :uid AND a.attempted_at >= :start AND a.attempted_at < :end
      AND (a.http_status IS NULL OR a.http_status NOT BETWEEN 200 AND 299)
    GROUP BY 1
    ORDER BY 2 DESC
""")

_TOP_ENDPOINTS = text("""
    SELECT ep.id, ep.name, count(*) AS total,
           count(*) FILTER (WHERE e.status = 'delivered') AS delivered,
           count(*) FILTER (WHERE e.status IN ('delivered', 'failed')) AS settled
    FROM events e JOIN endpoints ep ON ep.id = e.endpoint_id
    WHERE ep.user_id = :uid AND e.created_at >= :start AND e.created_at < :end
    GROUP BY ep.id, ep.name
    ORDER BY total DESC
    LIMIT 5
""")

_FAILED_TYPES = text("""
    SELECT e.event_type, count(*)
    FROM events e JOIN endpoints ep ON ep.id = e.endpoint_id
    WHERE ep.user_id = :uid AND e.created_at >= :start AND e.created_at < :end AND e.status = 'failed'
    GROUP BY e.event_type
    ORDER BY 2 DESC, 1
    LIMIT 5
""")


@dataclass(frozen=True)
class Window:
    start: datetime
    end: datetime
    step: timedelta

    @classmethod
    def for_range(cls, range_: str, now: datetime | None = None) -> Window:
        now = now or datetime.now(UTC)
        step = STEP[range_]
        step_s = int(step.total_seconds())
        end_ts = -(-int(now.timestamp()) // step_s) * step_s  # ceil to bucket boundary
        end = datetime.fromtimestamp(end_ts, UTC)
        return cls(start=end - RANGE[range_], end=end, step=step)

    def params(self, user_id: uuid.UUID) -> dict:
        return {"uid": user_id, "start": self.start, "end": self.end, "step": self.step, "origin": self.start}

    def buckets(self) -> list[datetime]:
        n = int((self.end - self.start) / self.step)
        return [self.start + i * self.step for i in range(n)]


def _rate(ok: int, settled: int) -> float | None:
    return ok / settled if settled else None


def _ms(value) -> int | None:
    return None if value is None else round(float(value))


class AnalyticsService:
    def __init__(self, session: AsyncSession) -> None:
        self.session = session

    async def _series(self, user_id: uuid.UUID, window: Window) -> list[SeriesPoint]:
        params = window.params(user_id)
        counts = {r.bucket: r for r in await self.session.execute(_EVENT_SERIES, params)}
        latency = {r.bucket: r for r in await self.session.execute(_LATENCY_SERIES, params)}
        points = []
        for bucket in window.buckets():
            c = counts.get(bucket)
            lat = latency.get(bucket)
            points.append(
                SeriesPoint(
                    bucket=bucket,
                    total=c.total if c else 0,
                    delivered=c.delivered if c else 0,
                    failed=c.failed if c else 0,
                    avg_ms=_ms(lat.avg_ms) if lat else None,
                    p95_ms=_ms(lat.p95_ms) if lat else None,
                )
            )
        return points

    async def _latency(self, user_id: uuid.UUID, window: Window) -> tuple[int | None, int | None]:
        row = (await self.session.execute(_LATENCY_TOTAL, window.params(user_id))).one()
        return _ms(row[0]), _ms(row[1])

    async def dashboard_stats(self, user_id: uuid.UUID, range_: TimeRange) -> DashboardStats:
        window = Window.for_range(range_)
        series = await self._series(user_id, window)
        avg, _ = await self._latency(user_id, window)
        delivered = sum(p.delivered for p in series)
        failed = sum(p.failed for p in series)
        return DashboardStats(
            range=range_,
            total_events=sum(p.total for p in series),
            successful_deliveries=delivered,
            failed_deliveries=failed,
            success_rate=_rate(delivered, delivered + failed),
            avg_response_ms=avg,
            series=series,
        )

    async def overview(self, user_id: uuid.UUID, range_: TimeRange) -> AnalyticsOverview:
        window = Window.for_range(range_)
        params = window.params(user_id)
        series = await self._series(user_id, window)
        avg, p95 = await self._latency(user_id, window)
        delivered = sum(p.delivered for p in series)
        failed = sum(p.failed for p in series)
        failures = [FailureCount(reason=r, count=n) for r, n in await self.session.execute(_FAILURES, params)]
        top = [
            TopEndpoint(endpoint_id=i, name=name, total=total, success_rate=_rate(ok, settled))
            for i, name, total, ok, settled in await self.session.execute(_TOP_ENDPOINTS, params)
        ]
        failed_types = [
            FailedEventType(event_type=t, count=n)
            for t, n in await self.session.execute(_FAILED_TYPES, params)
        ]
        return AnalyticsOverview(
            range=range_,
            total_events=sum(p.total for p in series),
            success_rate=_rate(delivered, delivered + failed),
            avg_latency_ms=avg,
            p95_latency_ms=p95,
            series=series,
            failure_distribution=failures,
            top_endpoints=top,
            top_failed_event_types=failed_types,
        )

    async def activity(self, user_id: uuid.UUID, limit: int) -> list[ActivityItem]:
        rows = (
            await self.session.execute(
                select(Event, Endpoint.name)
                .join(Endpoint, Endpoint.id == Event.endpoint_id)
                .where(Endpoint.user_id == user_id)
                .order_by(Event.created_at.desc(), Event.id.desc())
                .limit(limit)
            )
        ).all()
        repo = DeliveryRepository(self.session)
        latest = await repo.latest_for_events([e.id for e, _ in rows])
        last = await repo.last_attempts([d.id for d in latest.values()])
        items = []
        for event, endpoint_name in rows:
            d = latest.get(event.id)
            a = last.get(d.id) if d else None
            items.append(
                ActivityItem(
                    event_id=event.id,
                    delivery_id=d.id if d else None,
                    event_type=event.event_type,
                    endpoint_id=event.endpoint_id,
                    endpoint_name=endpoint_name,
                    status=event.status,
                    http_status=a.http_status if a else None,
                    duration_ms=a.duration_ms if a else None,
                    created_at=event.created_at,
                )
            )
        return items
