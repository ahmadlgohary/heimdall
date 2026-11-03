"""Delivery worker: consumes jobs from RabbitMQ and runs them.

Run: python -m app.workers.delivery_worker

Messages are acked only after the attempt's database writes commit. Messages
that can't be parsed, or that fail twice, go to the dead-letter queue for
inspection rather than looping forever.
"""

import asyncio
import contextlib
import logging
import signal

import httpx
from aio_pika.abc import AbstractIncomingMessage

from app.core.config import Settings, get_settings
from app.core.logging import configure_logging
from app.db.session import create_engine, create_session_factory
from app.messaging.connection import connect, open_channel
from app.messaging.messages import DeliveryJob
from app.messaging.topology import declare_topology
from app.services.storage_service import PayloadStorage, build_storage
from app.workers.delivery_executor import DeliveryExecutor
from app.workers.heartbeat import beat, worker_id

logger = logging.getLogger(__name__)


def build_http_client(settings: Settings) -> httpx.AsyncClient:
    return httpx.AsyncClient(
        timeout=httpx.Timeout(settings.delivery_timeout, connect=settings.delivery_connect_timeout),
        follow_redirects=False,
        trust_env=False,  # never route deliveries through ambient proxies
        limits=httpx.Limits(max_connections=settings.worker_concurrency * 2, max_keepalive_connections=20),
    )


async def handle_message(executor: DeliveryExecutor, message: AbstractIncomingMessage) -> None:
    try:
        job = DeliveryJob.decode(message.body)
    except Exception:
        logger.error("unparseable delivery message; dead-lettering", extra={"message_id": message.message_id})
        await message.reject(requeue=False)
        return
    try:
        await executor.process(job)
    except Exception:
        logger.exception("delivery processing error", extra={"delivery_id": str(job.delivery_id)})
        if message.redelivered:
            await message.reject(requeue=False)  # second failure: park it in the dead-letter queue
        else:
            await asyncio.sleep(1)
            await message.nack(requeue=True)
        return
    await message.ack()


async def run(
    settings: Settings,
    stop: asyncio.Event,
    *,
    storage: PayloadStorage | None = None,
    http: httpx.AsyncClient | None = None,
    factory=None,
) -> None:
    engine = None
    if factory is None:
        engine = create_engine(settings)
        factory = create_session_factory(engine)
    storage = storage or build_storage(settings)
    own_http = http is None
    http = http or build_http_client(settings)
    executor = DeliveryExecutor(factory, storage, settings, http)
    wid = worker_id("worker")

    connection = await connect(settings.rabbitmq_url)
    inflight: set[asyncio.Task] = set()

    async def on_message(message: AbstractIncomingMessage) -> None:
        task = asyncio.current_task()
        if task:
            inflight.add(task)
        try:
            await handle_message(executor, message)
        finally:
            if task:
                inflight.discard(task)

    async def heartbeat() -> None:
        while not stop.is_set():
            try:
                await beat(factory, wid, "worker")
            except Exception:
                logger.warning("heartbeat failed")
            with contextlib.suppress(TimeoutError):
                await asyncio.wait_for(stop.wait(), timeout=10)

    try:
        channel = await open_channel(connection, prefetch=settings.worker_concurrency)
        _, queue = await declare_topology(channel)
        tag = await queue.consume(on_message)
        hb = asyncio.create_task(heartbeat())
        logger.info(
            "delivery worker started", extra={"worker_id": wid, "concurrency": settings.worker_concurrency}
        )
        await stop.wait()
        await queue.cancel(tag)
        if inflight:
            await asyncio.wait(inflight, timeout=settings.delivery_timeout + 5)
        hb.cancel()
    finally:
        await connection.close()
        if own_http:
            await http.aclose()
        if engine is not None:
            await engine.dispose()
        logger.info("delivery worker stopped")


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
