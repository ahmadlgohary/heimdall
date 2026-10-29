from fastapi import APIRouter

from app.api.v1 import api_keys, auth, deliveries, endpoints, events, ingest
from app.api.v1.analytics import analytics_router, dashboard_router

api_router = APIRouter(prefix="/api/v1")
for r in (
    auth.router,
    dashboard_router,
    analytics_router,
    endpoints.router,
    events.router,
    deliveries.router,
    api_keys.router,
    ingest.router,
):
    api_router.include_router(r)
