from typing import Annotated

from fastapi import APIRouter, Query

from app.api.dependencies import CurrentUser, SessionDep
from app.schemas.analytics import AnalyticsOverview, DashboardActivity, DashboardStats, TimeRange
from app.services.analytics_service import AnalyticsService

dashboard_router = APIRouter(prefix="/dashboard", tags=["dashboard"])
analytics_router = APIRouter(prefix="/analytics", tags=["analytics"])


@dashboard_router.get("/stats")
async def dashboard_stats(user: CurrentUser, db: SessionDep, range: TimeRange = "24h") -> DashboardStats:
    return await AnalyticsService(db).dashboard_stats(user.id, range)


@dashboard_router.get("/activity")
async def dashboard_activity(
    user: CurrentUser, db: SessionDep, limit: Annotated[int, Query(ge=1, le=100)] = 20
) -> DashboardActivity:
    return DashboardActivity(items=await AnalyticsService(db).activity(user.id, limit))


@analytics_router.get("/overview")
async def analytics_overview(user: CurrentUser, db: SessionDep, range: TimeRange = "7d") -> AnalyticsOverview:
    return await AnalyticsService(db).overview(user.id, range)
