import asyncio
import contextlib
import logging
import time
import uuid
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware

from app.api.health import router as health_router
from app.api.v1.router import api_router
from app.core.config import Settings, get_settings
from app.core.exceptions import register_exception_handlers
from app.core.logging import configure_logging
from app.db.session import create_engine, create_session_factory
from app.services.storage_service import PayloadStorage, build_storage

logger = logging.getLogger("app.request")


def create_app(settings: Settings | None = None, *, storage: PayloadStorage | None = None) -> FastAPI:
    settings = settings or get_settings()
    configure_logging(settings.log_level, settings.json_logs)

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:

        engine = create_engine(settings)
        app.state.engine = engine
        app.state.session_factory = create_session_factory(engine)
        stop = asyncio.Event()
        publisher_task = None
        if settings.run_publisher_in_api:
            from app.workers import outbox_worker

            publisher_task = asyncio.create_task(outbox_worker.run(settings, stop, app.state.session_factory))
        try:
            yield
        finally:
            stop.set()
            if publisher_task:
                with contextlib.suppress(Exception):
                    await asyncio.wait_for(publisher_task, timeout=10)
            await engine.dispose()

    app = FastAPI(
        title="Heimdall API",
        version="1.0.0",
        lifespan=lifespan,
        docs_url="/docs",
        redoc_url=None,
        openapi_url="/openapi.json",
    )
    app.state.settings = settings
    app.state.storage = storage or build_storage(settings)

    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        allow_credentials=True,
        allow_methods=["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
        allow_headers=["Authorization", "Content-Type", "Idempotency-Key"],
        expose_headers=["Idempotent-Replayed", "Retry-After", "X-Request-ID"],
        max_age=600,
    )

    @app.middleware("http")
    async def request_context(request: Request, call_next):
        request_id = request.headers.get("x-request-id") or uuid.uuid4().hex
        started = time.perf_counter()
        response = await call_next(request)
        response.headers["X-Request-ID"] = request_id
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["Referrer-Policy"] = "no-referrer"
        if request.url.path not in ("/health", "/ready"):
            logger.info(
                "request",
                extra={
                    "request_id": request_id,
                    "method": request.method,
                    "path": request.url.path,  # no query string: it may carry search terms
                    "status": response.status_code,
                    "duration_ms": round((time.perf_counter() - started) * 1000, 1),
                },
            )
        return response

    register_exception_handlers(app)
    app.include_router(health_router)
    app.include_router(api_router)
    if settings.demo_receiver_enabled:
        from app.dev.mock_receiver import router as receiver_router

        app.include_router(receiver_router, prefix="/demo-receiver", include_in_schema=False)
    return app


app = create_app()

if __name__ == "__main__":
    import uvicorn

    uvicorn.run("app.main:app", host="0.0.0.0", port=8000, reload=True)  # noqa: S104 (local dev entry point)
