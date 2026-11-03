"""Outbox publisher: relays committed outbox rows to RabbitMQ (transactional outbox).

Run: python -m app.workers.outbox_worker

At-least-once: a crash between publishing and marking the row published means
the row is published again. Consumers dedupe on (delivery_id, attempt_number).
"""

import asyncio
import contextlib
import logging
import signal
import time
from datetime import UTC, datetime

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.core.config import Settings, get_settings
from app.core.logging import configure_logging
from app.db.models import OutboxMessage
from app.db.session import create_engine, create_session_factory
from app.messaging.connection import connect, open_channel
from app.messaging.messages import DeliveryJob
from app.messaging.publisher import JobPublisher
from app.messaging.topology import declare_topology
from app.workers.heartbeat import beat, worker_id
from app.workers.retry_scheduler import requeue_stalled

logger = logging.getLogger(__name__)

BATCH_SIZE = 100
HEARTBEAT_EVERY = 10.0
SWEEP_EVERY = 30.0


async def relay_once(factory: async_sessionmaker[AsyncSession], publisher: JobPublisher) -> int:
    """Publish one batch of unpublished rows. Returns how many were published."""
    published = 0
    async with factory() as session:
        rows = await session.scalars(
            select(OutboxMessage)
            .where(OutboxMessage.published_at.is_(None))
            .order_by(OutboxMessage.created_at)
            .limit(BATCH_SIZE)
            .with_for_update(skip_locked=True)
        )
        for row in rows:
            try:
                await publisher.publish(DeliveryJob.model_validate(row.payload))
            except Exception as exc:
                row.publish_attempts += 1
                row.last_error = f"{type(exc).__name__}: {exc}"[:500]
                logger.error(
                    "outbox publish failed", extra={"outbox_id": str(row.id), "error": row.last_error}
                )
                break  # broker trouble: commit progress so far and back off
            row.published_at = datetime.now(UTC)
            published += 1
        await session.commit()
    return published


async def backlog(session: AsyncSession) -> int:
    return int(
        await session.scalar(
            select(func.count()).select_from(OutboxMessage).where(OutboxMessage.published_at.is_(None))
        )
        or 0
    )


async def run(
    settings: Settings, stop: asyncio.Event, factory: async_sessionmaker[AsyncSession] | None = None
):
    own_engine = None
    if factory is None:
        own_engine = create_engine(settings)
        factory = create_session_factory(own_engine)
    wid = worker_id("publisher")
    connection = await connect(settings.rabbitmq_url)
    try:
        channel = await open_channel(connection)
        exchange, _ = await declare_topology(channel)
        publisher = JobPublisher(exchange)
        logger.info("outbox publisher started", extra={"worker_id": wid})
        last_beat = last_sweep = 0.0
        backoff = settings.outbox_poll_interval
        while not stop.is_set():
            try:
                n = await relay_once(factory, publisher)
                now = time.monotonic()
                if now - last_sweep > SWEEP_EVERY:
                    async with factory() as session:
                        await requeue_stalled(session)
                    last_sweep = now
                if now - last_beat > HEARTBEAT_EVERY:
                    await beat(factory, wid, "publisher")
                    last_beat = now
                backoff = settings.outbox_poll_interval
                if n == BATCH_SIZE:
                    continue  # more waiting, don't sleep
            except Exception:
                logger.exception("outbox loop error")
                backoff = min(backoff * 2, 10.0)
            with contextlib.suppress(TimeoutError):
                await asyncio.wait_for(stop.wait(), timeout=backoff)
    finally:
        await connection.close()
        if own_engine is not None:
            await own_engine.dispose()
        logger.info("outbox publisher stopped")


def main() -> None:
    settings = get_settings()
    configure_logging(settings.log_level, settings.json_logs)

    async def _main() -> None:
        stop = asyncio.Event()
        loop = asyncio.get_running_loop()
        for sig in (signal.SIGINT, signal.SIGTERM):
            loop.add_signal_handler(sig, stop.set)
        await run(settings, stop)

    asyncio.run(_main())


if __name__ == "__main__":
    main()
