import asyncio
from datetime import UTC, datetime, timedelta

import aio_pika
from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse
from sqlalchemy import func, select, text

from app.db.models import WorkerHeartbeat
from app.messaging.topology import DEAD_LETTER_QUEUE, DELIVERY_QUEUE
from app.workers.outbox_worker import backlog

router = APIRouter(tags=["health"])

STALE_AFTER = timedelta(seconds=45)
# Hosted brokers over TLS (e.g. CloudAMQP) take a few seconds to handshake.
BROKER_CHECK_TIMEOUT = 10


@router.get("/health")
async def health() -> dict:
    """Process liveness."""
    return {"status": "ok"}


@router.get("/ready")
async def ready(request: Request) -> JSONResponse:
    """Database and broker readiness, plus queue depth, outbox backlog and worker liveness."""
    settings = request.app.state.settings
    checks: dict = {}
    ok = True

    try:
        async with request.app.state.session_factory() as session:
            await session.execute(text("SELECT 1"))
            checks["outbox_backlog"] = await backlog(session)
            since = datetime.now(UTC) - STALE_AFTER
            rows = await session.execute(
                select(WorkerHeartbeat.kind, func.count())
                .where(WorkerHeartbeat.last_seen_at >= since)
                .group_by(WorkerHeartbeat.kind)
            )
            checks["live_processes"] = {kind: n for kind, n in rows}
        checks["database"] = "ok"
    except Exception as exc:
        ok = False
        checks["database"] = f"error: {type(exc).__name__}"

    try:
        async with asyncio.timeout(BROKER_CHECK_TIMEOUT):
            connection = await aio_pika.connect(settings.rabbitmq_url)
            async with connection:
                channel = await connection.channel()
                depths = {}
                for name in (DELIVERY_QUEUE, DEAD_LETTER_QUEUE):
                    try:
                        q = await channel.declare_queue(name, passive=True)
                        depths[name] = q.declaration_result.message_count
                    except Exception:
                        channel = await connection.channel()  # passive miss closes the channel
                        depths[name] = None
                checks["queue_depth"] = depths
        checks["rabbitmq"] = "ok"
    except Exception as exc:
        ok = False
        checks["rabbitmq"] = f"error: {type(exc).__name__}"

    return JSONResponse(
        {"status": "ready" if ok else "unavailable", "checks": checks}, status_code=200 if ok else 503
    )
