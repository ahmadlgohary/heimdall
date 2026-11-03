"""Delivery executor against real PostgreSQL with a mocked HTTP destination."""

import asyncio
from datetime import UTC, datetime, timedelta

import httpx
import pytest
from sqlalchemy import func, select, update

from app.db.models import Delivery, DeliveryAttempt, Endpoint, Event, OutboxMessage
from app.messaging.messages import DeliveryJob
from app.utils.signatures import verify_signature
from app.workers.delivery_executor import DeliveryExecutor, Outcome
from tests.conftest import PUBLIC_IP, create_endpoint, ingest


class Receiver:
    """Scriptable destination. `responses` are consumed in order; the last one repeats."""

    def __init__(self, *responses):
        self.responses = list(responses) or [httpx.Response(200, json={"received": True})]
        self.requests: list[httpx.Request] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        r = self.responses.pop(0) if len(self.responses) > 1 else self.responses[0]
        if isinstance(r, Exception):
            raise r
        return r


@pytest.fixture
async def make_executor(session_factory, storage, settings):
    clients = []

    def make(receiver: Receiver, **overrides) -> DeliveryExecutor:
        http = httpx.AsyncClient(transport=httpx.MockTransport(receiver))
        clients.append(http)
        return DeliveryExecutor(session_factory, storage, settings.model_copy(update=overrides), http)

    yield make
    for c in clients:
        await c.aclose()


async def _event(client, ready, db):
    res = await ingest(client, ready.endpoint["id"], ready.key, idempotency_key=None)
    event_id = res.json()["event_id"]
    delivery = await db.scalar(select(Delivery).where(Delivery.event_id == event_id))
    return event_id, delivery.id


async def _state(db, delivery_id):
    db.expire_all()
    d = await db.get(Delivery, delivery_id)
    e = await db.get(Event, d.event_id)
    attempts = (
        await db.scalars(
            select(DeliveryAttempt)
            .where(DeliveryAttempt.delivery_id == delivery_id)
            .order_by(DeliveryAttempt.attempt_number)
        )
    ).all()
    return d, e, attempts


async def test_successful_delivery_is_signed_and_recorded(client, db, ready, make_executor):
    event_id, delivery_id = await _event(client, ready, db)
    receiver = Receiver(
        httpx.Response(200, json={"ok": True}, headers={"set-cookie": "s=1", "x-trace": "abc"})
    )
    outcome = await make_executor(receiver).process(DeliveryJob(delivery_id=delivery_id, attempt_number=1))
    assert outcome is Outcome.DELIVERED

    (req,) = receiver.requests
    # connected to the vetted IP, with the original Host and SNI
    assert req.url.host == str(PUBLIC_IP) and req.headers["host"] == "hooks.example.com"
    assert req.extensions["sni_hostname"] == "hooks.example.com"
    assert req.url.path == "/orders"
    assert req.headers["x-webhook-id"] == event_id
    assert req.headers["x-webhook-event"] == "order.created"
    assert req.headers["x-webhook-attempt"] == "1"
    body = req.content
    assert verify_signature(
        ready.endpoint["signing_secret"],
        req.headers["x-webhook-timestamp"],
        body,
        req.headers["x-webhook-signature"],
    )

    d, e, attempts = await _state(db, delivery_id)
    assert d.status == e.status == "delivered" and d.current_attempt == 1 and d.completed_at
    (a,) = attempts
    assert a.http_status == 200 and a.duration_ms is not None and a.response_body == '{"ok":true}'
    assert "set-cookie" not in a.response_headers and a.response_headers["x-trace"] == "abc"


async def test_server_error_schedules_retry_with_backoff(client, db, ready, make_executor):
    _, delivery_id = await _event(client, ready, db)
    before = datetime.now(UTC)
    outcome = await make_executor(Receiver(httpx.Response(500, text="boom"))).process(
        DeliveryJob(delivery_id=delivery_id, attempt_number=1)
    )
    assert outcome is Outcome.RETRY_SCHEDULED
    d, e, attempts = await _state(db, delivery_id)
    assert d.status == e.status == "retrying" and d.current_attempt == 1
    assert timedelta(seconds=29) < d.next_attempt_at - before < timedelta(seconds=32)
    assert attempts[0].http_status == 500 and attempts[0].response_body == "boom"

    retry = await db.scalar(
        select(OutboxMessage)
        .where(OutboxMessage.delivery_id == delivery_id)
        .order_by(OutboxMessage.created_at.desc())
    )
    assert retry.payload["attempt_number"] == 2 and retry.payload["not_before"] is not None


async def test_client_error_is_not_retried(client, db, ready, make_executor):
    _, delivery_id = await _event(client, ready, db)
    outcome = await make_executor(Receiver(httpx.Response(404))).process(
        DeliveryJob(delivery_id=delivery_id, attempt_number=1)
    )
    assert outcome is Outcome.FAILED
    d, e, _ = await _state(db, delivery_id)
    assert d.status == e.status == "failed" and d.next_attempt_at is None


async def test_429_respects_retry_after(client, db, ready, make_executor):
    _, delivery_id = await _event(client, ready, db)
    before = datetime.now(UTC)
    await make_executor(Receiver(httpx.Response(429, headers={"Retry-After": "300"}))).process(
        DeliveryJob(delivery_id=delivery_id, attempt_number=1)
    )
    d, _, _ = await _state(db, delivery_id)
    assert timedelta(seconds=299) < d.next_attempt_at - before < timedelta(seconds=302)


async def test_retries_stop_after_max_attempts_then_succeed_path(client, db, ready, make_executor):
    _, delivery_id = await _event(client, ready, db)
    executor = make_executor(Receiver(httpx.Response(503)))
    for n in range(1, 6):
        # make the scheduled retry due now
        await db.execute(update(Delivery).where(Delivery.id == delivery_id).values(next_attempt_at=None))
        await db.commit()
        outcome = await executor.process(DeliveryJob(delivery_id=delivery_id, attempt_number=n))
    assert outcome is Outcome.FAILED
    d, e, attempts = await _state(db, delivery_id)
    assert d.status == e.status == "failed" and [a.attempt_number for a in attempts] == [1, 2, 3, 4, 5]
    # a 6th message (e.g. a duplicate) does nothing
    assert await executor.process(DeliveryJob(delivery_id=delivery_id, attempt_number=6)) is Outcome.SKIPPED


async def test_failure_then_success_preserves_history(client, db, ready, make_executor):
    _, delivery_id = await _event(client, ready, db)
    executor = make_executor(Receiver(httpx.Response(500), httpx.Response(200)))
    assert (
        await executor.process(DeliveryJob(delivery_id=delivery_id, attempt_number=1))
        is Outcome.RETRY_SCHEDULED
    )
    await db.execute(
        update(Delivery).where(Delivery.id == delivery_id).values(next_attempt_at=datetime.now(UTC))
    )
    await db.commit()
    assert await executor.process(DeliveryJob(delivery_id=delivery_id, attempt_number=2)) is Outcome.DELIVERED
    _, e, attempts = await _state(db, delivery_id)
    assert e.status == "delivered" and [a.http_status for a in attempts] == [500, 200]


async def test_duplicate_messages_do_not_duplicate_attempts(client, db, ready, make_executor):
    _, delivery_id = await _event(client, ready, db)
    receiver = Receiver()
    executor = make_executor(receiver)
    job = DeliveryJob(delivery_id=delivery_id, attempt_number=1)
    assert await executor.process(job) is Outcome.DELIVERED
    assert await executor.process(job) is Outcome.SKIPPED
    assert len(receiver.requests) == 1
    assert len((await _state(db, delivery_id))[2]) == 1


async def test_concurrent_workers_do_not_process_the_same_attempt(client, db, ready, make_executor):
    _, delivery_id = await _event(client, ready, db)

    async def slow(request):
        await asyncio.sleep(0.2)
        return httpx.Response(200)

    class SlowReceiver(Receiver):
        async def __call__(self, request):  # type: ignore[override]
            self.requests.append(request)
            return await slow(request)

    receiver = SlowReceiver()
    job = DeliveryJob(delivery_id=delivery_id, attempt_number=1)
    outcomes = await asyncio.gather(*(make_executor(receiver).process(job) for _ in range(4)))
    assert sorted(o.value for o in outcomes) == ["delivered", "skipped", "skipped", "skipped"]
    assert len(receiver.requests) == 1
    assert len((await _state(db, delivery_id))[2]) == 1


async def test_expired_lease_lets_another_worker_take_over(client, db, ready, make_executor):
    _, delivery_id = await _event(client, ready, db)
    past = datetime.now(UTC) - timedelta(minutes=5)
    await db.execute(
        update(Delivery).where(Delivery.id == delivery_id).values(status="delivering", locked_until=past)
    )
    await db.commit()
    outcome = await make_executor(Receiver()).process(DeliveryJob(delivery_id=delivery_id, attempt_number=1))
    assert outcome is Outcome.DELIVERED


async def test_timeouts_and_connection_errors_are_retried(client, db, ready, make_executor):
    _, d1 = await _event(client, ready, db)
    await make_executor(Receiver(httpx.ReadTimeout("slow"))).process(
        DeliveryJob(delivery_id=d1, attempt_number=1)
    )
    d, _, attempts = await _state(db, d1)
    assert d.status == "retrying" and attempts[0].http_status is None
    assert attempts[0].error_message.startswith("Timed out")

    _, d2 = await _event(client, ready, db)
    await make_executor(Receiver(httpx.ConnectError("refused"))).process(
        DeliveryJob(delivery_id=d2, attempt_number=1)
    )
    d, _, attempts = await _state(db, d2)
    assert d.status == "retrying" and attempts[0].error_message.startswith("Connection failed")


async def test_redirects_are_not_followed(client, db, ready, make_executor):
    _, delivery_id = await _event(client, ready, db)
    receiver = Receiver(httpx.Response(302, headers={"location": "http://169.254.169.254/"}))
    assert (
        await make_executor(receiver).process(DeliveryJob(delivery_id=delivery_id, attempt_number=1))
        is Outcome.FAILED
    )
    assert len(receiver.requests) == 1
    _, _, attempts = await _state(db, delivery_id)
    assert attempts[0].http_status == 302 and "Redirects" in attempts[0].error_message


async def test_dns_rebinding_is_blocked_at_delivery_time(client, db, ready, make_executor):
    # endpoint was validated when it pointed at a public host...
    _, delivery_id = await _event(client, ready, db)
    # ...then its hostname starts resolving to a private address
    await db.execute(
        update(Endpoint)
        .where(Endpoint.id == ready.endpoint["id"])
        .values(url="https://svc.internal-dns.test/hook")
    )
    await db.commit()
    receiver = Receiver()
    assert (
        await make_executor(receiver).process(DeliveryJob(delivery_id=delivery_id, attempt_number=1))
        is Outcome.FAILED
    )
    assert receiver.requests == []
    _, _, attempts = await _state(db, delivery_id)
    assert attempts[0].error_message.startswith("Destination blocked")


async def test_disabled_endpoint_stops_delivery(client, db, ready, make_executor):
    _, delivery_id = await _event(client, ready, db)
    await db.execute(update(Endpoint).where(Endpoint.id == ready.endpoint["id"]).values(enabled=False))
    await db.commit()
    receiver = Receiver()
    assert (
        await make_executor(receiver).process(DeliveryJob(delivery_id=delivery_id, attempt_number=1))
        is Outcome.FAILED
    )
    assert receiver.requests == []


async def test_storage_outage_releases_attempt_without_charging_it(client, db, ready, storage, make_executor):
    _, delivery_id = await _event(client, ready, db)
    storage.fail = True
    assert (
        await make_executor(Receiver()).process(DeliveryJob(delivery_id=delivery_id, attempt_number=1))
        is Outcome.RESCHEDULED
    )
    d, _, attempts = await _state(db, delivery_id)
    assert d.status == "retrying" and d.current_attempt == 0 and attempts == []
    requeued = await db.scalar(
        select(func.count()).select_from(OutboxMessage).where(OutboxMessage.delivery_id == delivery_id)
    )
    assert requeued == 2


async def test_early_message_is_rescheduled(client, db, ready, make_executor):
    _, delivery_id = await _event(client, ready, db)
    executor = make_executor(Receiver(httpx.Response(500)))
    await executor.process(DeliveryJob(delivery_id=delivery_id, attempt_number=1))
    receiver = Receiver()
    outcome = await make_executor(receiver).process(DeliveryJob(delivery_id=delivery_id, attempt_number=2))
    assert outcome is Outcome.RESCHEDULED and receiver.requests == []


async def test_event_status_follows_latest_execution(client, db, ready, make_executor):
    event_id, first = await _event(client, ready, db)
    await make_executor(Receiver(httpx.Response(404))).process(
        DeliveryJob(delivery_id=first, attempt_number=1)
    )
    replay = (await client.post(f"/api/v1/events/{event_id}/replay", headers=ready.account.headers)).json()
    await make_executor(Receiver()).process(DeliveryJob(delivery_id=replay["id"], attempt_number=1))
    detail = (await client.get(f"/api/v1/events/{event_id}", headers=ready.account.headers)).json()
    assert detail["status"] == "delivered" and detail["attempts"] == 2
    deliveries = (
        await client.get(f"/api/v1/events/{event_id}/deliveries", headers=ready.account.headers)
    ).json()
    assert [d["status"] for d in deliveries["items"]] == ["delivered", "failed"]
    assert deliveries["items"][0]["last_http_status"] == 200


async def test_dashboard_and_analytics_reflect_deliveries(client, db, ready, make_executor):
    second = await create_endpoint(client, ready.account, url="https://billing.example.com/x", name="Billing")
    ok_executor = make_executor(Receiver(httpx.Response(200)))
    for _ in range(3):
        _, d = await _event(client, ready, db)
        await ok_executor.process(DeliveryJob(delivery_id=d, attempt_number=1))
    res = await ingest(client, second["id"], ready.key, {"event_type": "invoice.paid", "data": {}})
    failing = await db.scalar(select(Delivery).where(Delivery.event_id == res.json()["event_id"]))
    await make_executor(Receiver(httpx.Response(400))).process(
        DeliveryJob(delivery_id=failing.id, attempt_number=1)
    )

    h = ready.account.headers
    stats = (await client.get("/api/v1/dashboard/stats?range=24h", headers=h)).json()
    assert (
        stats["total_events"] == 4 and stats["successful_deliveries"] == 3 and stats["failed_deliveries"] == 1
    )
    assert stats["success_rate"] == 0.75 and stats["avg_response_ms"] is not None
    assert len(stats["series"]) == 24 and sum(p["total"] for p in stats["series"]) == 4

    overview = (await client.get("/api/v1/analytics/overview?range=7d", headers=h)).json()
    assert len(overview["series"]) == 14
    assert overview["failure_distribution"] == [{"reason": "http_4xx", "count": 1}]
    assert overview["top_endpoints"][0]["name"] == "Orders" and overview["top_endpoints"][0]["total"] == 3
    assert overview["top_failed_event_types"] == [{"event_type": "invoice.paid", "count": 1}]
    assert overview["p95_latency_ms"] is not None

    activity = (await client.get("/api/v1/dashboard/activity?limit=2", headers=h)).json()["items"]
    assert len(activity) == 2
    assert activity[0]["event_type"] == "invoice.paid" and activity[0]["http_status"] == 400

    endpoints = (await client.get("/api/v1/endpoints", headers=h)).json()["items"]
    orders = next(e for e in endpoints if e["name"] == "Orders")
    assert orders["stats"]["total_events"] == 3 and orders["stats"]["success_rate"] == 1.0
