"""Outbox publisher and worker against a real RabbitMQ broker."""

import asyncio
import contextlib
from datetime import UTC, datetime, timedelta

import aio_pika
import httpx
import pytest
from sqlalchemy import func, select, update

from app.db.models import Delivery, DeliveryAttempt, OutboxMessage
from app.messaging.connection import connect, open_channel
from app.messaging.messages import DeliveryJob
from app.messaging.publisher import JobPublisher
from app.messaging.topology import (
    DEAD_LETTER_QUEUE,
    DELAY_TIERS,
    DELIVERY_QUEUE,
    declare_topology,
    delay_queue,
)
from app.workers import delivery_worker
from app.workers.outbox_worker import relay_once
from app.workers.retry_scheduler import requeue_stalled
from tests.conftest import ingest

ALL_QUEUES = (DELIVERY_QUEUE, DEAD_LETTER_QUEUE, *(delay_queue(t) for t in DELAY_TIERS))


@pytest.fixture
async def broker(settings):
    """(inspection channel, exchange, work queue). Inspection uses a plain channel:
    robust channels cache declarations, so their passive declares report stale counts."""
    connection = await connect(settings.rabbitmq_url)
    channel = await open_channel(connection)
    exchange, queue = await declare_topology(channel)
    plain = await aio_pika.connect(settings.rabbitmq_url)
    inspect = await plain.channel()
    for name in ALL_QUEUES:
        await (await inspect.declare_queue(name, passive=True)).purge()
    yield inspect, exchange, queue
    for name in ALL_QUEUES:
        with contextlib.suppress(Exception):
            await (await inspect.declare_queue(name, passive=True)).purge()
    await plain.close()
    await connection.close()


async def depth(channel, name: str) -> int:
    q = await channel.declare_queue(name, passive=True)
    return q.declaration_result.message_count


async def wait_for(predicate, limit=10.0):
    deadline = asyncio.get_running_loop().time() + limit
    while asyncio.get_running_loop().time() < deadline:
        if await predicate():
            return True
        await asyncio.sleep(0.1)
    return False


async def test_publisher_relays_unpublished_outbox_rows(client, db, ready, session_factory, broker):
    channel, exchange, _ = broker
    for _ in range(3):
        await ingest(client, ready.endpoint["id"], ready.key)
    assert await relay_once(session_factory, JobPublisher(exchange)) == 3
    unpublished = await db.scalar(
        select(func.count()).select_from(OutboxMessage).where(OutboxMessage.published_at.is_(None))
    )
    assert unpublished == 0
    assert await wait_for(lambda: _eq(depth(channel, DELIVERY_QUEUE), 3))
    # nothing left to publish
    assert await relay_once(session_factory, JobPublisher(exchange)) == 0


async def _eq(coro, expected):
    return (await coro) == expected


async def test_publisher_recovers_after_crash_and_consumer_dedupes(
    client, db, ready, session_factory, broker, storage, settings
):
    """A crash after publishing but before marking the row means it is published twice;
    the worker must still record exactly one attempt."""
    channel, exchange, _ = broker
    res = await ingest(client, ready.endpoint["id"], ready.key)
    delivery = await db.scalar(select(Delivery).where(Delivery.event_id == res.json()["event_id"]))

    assert await relay_once(session_factory, JobPublisher(exchange)) == 1
    # simulate the crash: the mark-as-published never happened
    await db.execute(update(OutboxMessage).values(published_at=None))
    await db.commit()
    assert await relay_once(session_factory, JobPublisher(exchange)) == 1
    assert await wait_for(lambda: _eq(depth(channel, DELIVERY_QUEUE), 2))

    received = []

    def handler(request):
        received.append(request)
        return httpx.Response(200)

    stop = asyncio.Event()
    http = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    task = asyncio.create_task(
        delivery_worker.run(settings, stop, storage=storage, http=http, factory=session_factory)
    )
    try:
        assert await wait_for(lambda: _eq(depth(channel, DELIVERY_QUEUE), 0))
        await asyncio.sleep(0.3)
    finally:
        stop.set()
        await task
        await http.aclose()
    attempts = await db.scalar(
        select(func.count()).select_from(DeliveryAttempt).where(DeliveryAttempt.delivery_id == delivery.id)
    )
    assert attempts == 1 and len(received) == 1


async def test_end_to_end_ingest_publish_consume_deliver(
    client, db, ready, session_factory, broker, storage, settings
):
    _, exchange, _ = broker
    stop = asyncio.Event()
    bodies = []

    def handler(request):
        bodies.append(request)
        return httpx.Response(204)

    http = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    worker = asyncio.create_task(
        delivery_worker.run(settings, stop, storage=storage, http=http, factory=session_factory)
    )
    try:
        res = await ingest(client, ready.endpoint["id"], ready.key)
        event_id = res.json()["event_id"]
        await relay_once(session_factory, JobPublisher(exchange))

        async def delivered():
            r = await client.get(f"/api/v1/events/{event_id}", headers=ready.account.headers)
            return r.json()["status"] == "delivered"

        assert await wait_for(delivered)
    finally:
        stop.set()
        await worker
        await http.aclose()
    assert bodies[0].headers["x-webhook-id"] == event_id


async def test_failed_attempt_is_parked_in_delay_queue(
    client, db, ready, session_factory, broker, storage, settings
):
    channel, exchange, _ = broker
    stop = asyncio.Event()
    http = httpx.AsyncClient(transport=httpx.MockTransport(lambda r: httpx.Response(503)))
    worker = asyncio.create_task(
        delivery_worker.run(settings, stop, storage=storage, http=http, factory=session_factory)
    )
    try:
        res = await ingest(client, ready.endpoint["id"], ready.key)
        await relay_once(session_factory, JobPublisher(exchange))

        async def retrying():
            r = await client.get(f"/api/v1/events/{res.json()['event_id']}", headers=ready.account.headers)
            return r.json()["status"] == "retrying"

        assert await wait_for(retrying)
        # the worker committed a retry outbox row; publishing it routes to the 30 s delay queue
        assert await relay_once(session_factory, JobPublisher(exchange)) == 1
        assert await wait_for(lambda: _eq(depth(channel, delay_queue(30)), 1))
        assert await depth(channel, DELIVERY_QUEUE) == 0
    finally:
        stop.set()
        await worker
        await http.aclose()


async def test_delay_queue_dead_letters_back_to_work_queue(broker):
    channel, exchange, _ = broker
    job = DeliveryJob(
        delivery_id="2b1f8f4e-1d1a-4a51-9c39-0b5f3c0d2f11",
        attempt_number=2,
        not_before=datetime.now(UTC) + timedelta(seconds=6),
    )
    assert await JobPublisher(exchange).publish(job) == "delay.5s"
    assert await depth(channel, delay_queue(5)) == 1
    assert await wait_for(lambda: _eq(depth(channel, DELIVERY_QUEUE), 1), limit=12)


async def test_poison_messages_are_dead_lettered_for_inspection(broker, session_factory, storage, settings):
    channel, exchange, _ = broker
    await exchange.publish(
        aio_pika.Message(body=b"not json", delivery_mode=aio_pika.DeliveryMode.PERSISTENT), "deliver"
    )
    stop = asyncio.Event()
    http = httpx.AsyncClient(transport=httpx.MockTransport(lambda r: httpx.Response(200)))
    worker = asyncio.create_task(
        delivery_worker.run(settings, stop, storage=storage, http=http, factory=session_factory)
    )
    try:
        assert await wait_for(lambda: _eq(depth(channel, DEAD_LETTER_QUEUE), 1))
    finally:
        stop.set()
        await worker
        await http.aclose()
    dead = await channel.declare_queue(DEAD_LETTER_QUEUE, passive=True)
    message = await dead.get(no_ack=True)
    assert message.body == b"not json"


async def test_stalled_retries_are_requeued(client, db, ready):
    res = await ingest(client, ready.endpoint["id"], ready.key)
    long_ago = datetime.now(UTC) - timedelta(hours=1)
    await db.execute(
        update(Delivery)
        .where(Delivery.event_id == res.json()["event_id"])
        .values(status="retrying", current_attempt=1, next_attempt_at=long_ago)
    )
    await db.execute(update(OutboxMessage).values(created_at=long_ago, published_at=long_ago))
    await db.commit()
    assert await requeue_stalled(db) == 1
    newest = await db.scalar(select(OutboxMessage).order_by(OutboxMessage.created_at.desc()))
    assert newest.payload["attempt_number"] == 2 and newest.published_at is None
    # within the cooldown it isn't requeued again
    assert await requeue_stalled(db) == 0


async def test_ready_reports_queue_depth_and_backlog(client, ready):
    await ingest(client, ready.endpoint["id"], ready.key)
    res = await client.get("/ready")
    assert res.status_code == 200
    checks = res.json()["checks"]
    assert checks["database"] == "ok" and checks["rabbitmq"] == "ok"
    assert checks["outbox_backlog"] == 1 and DELIVERY_QUEUE in checks["queue_depth"]


async def test_publisher_process_runs_until_stopped(client, db, ready, session_factory, broker, settings):
    from app.workers import outbox_worker

    channel, _, _ = broker
    stop = asyncio.Event()
    task = asyncio.create_task(outbox_worker.run(settings, stop, session_factory))
    try:
        await ingest(client, ready.endpoint["id"], ready.key)
        assert await wait_for(lambda: _eq(depth(channel, DELIVERY_QUEUE), 1))
        res = await client.get("/ready")
        assert res.json()["checks"]["live_processes"] == {"publisher": 1}
    finally:
        stop.set()
        await asyncio.wait_for(task, 10)
