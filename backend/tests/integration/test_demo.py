"""Demo environment: seed script, fixture labelling, demo account guards, built-in receiver."""

import httpx
import pytest
from sqlalchemy import func, select

from app.db.models import Delivery, DeliveryAttempt, Endpoint, Event, OutboxMessage, User
from app.main import create_app
from app.messaging.messages import DeliveryJob
from app.scripts.seed import ENDPOINTS, seed
from app.workers.delivery_executor import DeliveryExecutor, Outcome

RECEIVER = "https://demo.example.com/demo-receiver"


@pytest.fixture
def demo_settings(settings):
    return settings.model_copy(
        update={"demo_enabled": True, "demo_receiver_enabled": True, "demo_receiver_url": RECEIVER}
    )


@pytest.fixture
async def demo_client(demo_settings, session_factory, storage, db):
    app = create_app(demo_settings, storage=storage)
    app.state.session_factory = session_factory
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as c:
        yield c, app


async def run_seed(demo_settings, session_factory, storage, **kw):
    kw.setdefault("events", 60)
    kw.setdefault("live", 2)
    return await seed(
        demo_settings, storage=storage, factory=session_factory, random_seed=7, log=lambda *_: None, **kw
    )


async def count(db, stmt):
    return await db.scalar(select(func.count()).select_from(stmt.subquery()))


async def test_seed_builds_a_labelled_demo_account(demo_settings, session_factory, storage, db):
    summary = await run_seed(demo_settings, session_factory, storage)
    assert summary["fixtures"] == 60 and summary["live_events"] == 2

    user = await db.scalar(select(User).where(User.email == demo_settings.demo_email))
    endpoints = (await db.scalars(select(Endpoint).where(Endpoint.user_id == user.id))).all()
    assert len(endpoints) == len(ENDPOINTS)
    assert all(e.url.startswith(f"{RECEIVER}/hooks/") for e in endpoints)
    assert [e.enabled for e in endpoints].count(False) == 1

    events = (await db.scalars(select(Event))).all()
    fixtures = [e for e in events if e.source == "demo_fixture"]
    live = [e for e in events if e.source == "live"]
    assert len(fixtures) == 60 and len(live) == 2
    assert {e.status for e in fixtures} <= {"delivered", "failed"}  # sample history is settled
    assert {e.status for e in live} == {"queued"}

    # fixtures are never published: only the live events have outbox rows
    outbox_events = set(await db.scalars(select(OutboxMessage.event_id)))
    assert outbox_events == {e.id for e in live}

    # every event's payload is really stored, so the payload view works
    assert set(storage.objects) == {e.payload_key for e in events}


async def test_fixture_histories_match_endpoint_behaviour(demo_settings, session_factory, storage, db):
    await run_seed(demo_settings, session_factory, storage, events=120, live=0)
    rows = await db.execute(
        select(Endpoint.url, Delivery.id, Delivery.status, Delivery.execution_number)
        .join(Event, Event.endpoint_id == Endpoint.id)
        .join(Delivery, Delivery.event_id == Event.id)
    )
    seen = set()
    for url, delivery_id, status, execution in rows:
        behaviour = url.rsplit("/", 1)[1]
        codes = list(
            await db.scalars(
                select(DeliveryAttempt.http_status)
                .where(DeliveryAttempt.delivery_id == delivery_id)
                .order_by(DeliveryAttempt.attempt_number)
            )
        )
        seen.add(behaviour)
        if behaviour == "flaky":
            assert codes == [503, 200] and status == "delivered"
        elif behaviour == "ratelimit":
            assert codes == [429, 200] and status == "delivered"
        elif behaviour == "notfound":
            assert codes == [404] and status == "failed"
        elif behaviour == "fail":
            assert len(codes) == 5 and status == "failed" and all(c in (500, None) for c in codes)
        else:
            assert codes[-1] == 200 and status == "delivered" and execution == 1
    assert {"ok", "flaky", "fail"} <= seen


async def test_reseeding_resets_everything(demo_settings, session_factory, storage, db):
    await run_seed(demo_settings, session_factory, storage)
    first_keys = set(storage.objects)
    await run_seed(demo_settings, session_factory, storage)
    assert await count(db, select(User)) == 1
    assert await count(db, select(Event)) == 62
    assert not (first_keys & set(storage.objects))  # old payloads removed, not orphaned
    assert len(storage.objects) == 62


async def test_demo_login_and_guards(demo_client, demo_settings, session_factory, storage):
    client, _ = demo_client
    await run_seed(demo_settings, session_factory, storage, live=0)

    info = (await client.get("/api/v1/demo")).json()
    assert info == {
        "enabled": True,
        "email": demo_settings.demo_email,
        "password": demo_settings.demo_password,
    }

    login = await client.post(
        "/api/v1/auth/login",
        json={"email": demo_settings.demo_email, "password": demo_settings.demo_password},
    )
    assert login.status_code == 200 and login.json()["user"]["is_demo"] is True
    headers = {"Authorization": f"Bearer {login.json()['access_token']}"}
    assert (await client.get("/api/v1/auth/me", headers=headers)).json()["is_demo"] is True

    change = await client.post(
        "/api/v1/auth/change-password",
        json={"current_password": demo_settings.demo_password, "new_password": "Hijacked-Passw0rd"},
        headers=headers,
    )
    assert change.status_code == 403 and change.json()["error"]["code"] == "DEMO_ACCOUNT"

    taken = await client.post(
        "/api/v1/auth/register",
        json={"email": demo_settings.demo_email.upper(), "password": "Whatever-Passw0rd"},
    )
    assert taken.status_code == 409

    events = (await client.get("/api/v1/events?limit=5", headers=headers)).json()
    assert events["pagination"]["total"] == 60
    assert {e["source"] for e in events["items"]} == {"demo_fixture"}
    stats = (await client.get("/api/v1/dashboard/stats?range=30d", headers=headers)).json()
    assert stats["total_events"] == 60 and stats["failed_deliveries"] > 0


async def test_demo_info_when_disabled(client):
    assert (await client.get("/api/v1/demo")).json() == {"enabled": False, "email": None, "password": None}
    me = await client.post(
        "/api/v1/auth/register", json={"email": "x@example.com", "password": "Regular-Passw0rd"}
    )
    assert me.json()["user"]["is_demo"] is False


async def test_built_in_receiver_behaviours(demo_client):
    client, _ = demo_client
    flaky1 = await client.post("/demo-receiver/hooks/flaky", json={}, headers={"X-Webhook-Attempt": "1"})
    flaky2 = await client.post("/demo-receiver/hooks/flaky", json={}, headers={"X-Webhook-Attempt": "2"})
    rate = await client.post("/demo-receiver/hooks/ratelimit", json={}, headers={"X-Webhook-Attempt": "1"})
    assert (flaky1.status_code, flaky2.status_code) == (503, 200)
    assert rate.status_code == 429 and rate.headers["retry-after"] == "40"
    assert (await client.get("/demo-receiver/requests")).status_code == 200


async def test_receiver_not_mounted_by_default(client):
    assert (await client.post("/demo-receiver/hooks/ok", json={})).status_code == 404


async def test_live_demo_event_is_delivered_to_the_built_in_receiver(
    demo_client, demo_settings, session_factory, storage, db
):
    """A live demo event goes through the real worker to the API's own receiver."""
    _, app = demo_client
    await run_seed(demo_settings, session_factory, storage, events=5, live=1)
    live = await db.scalar(select(Event).where(Event.source == "live"))
    delivery = await db.scalar(select(Delivery).where(Delivery.event_id == live.id))

    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app)) as http:
        outcome = await DeliveryExecutor(session_factory, storage, demo_settings, http).process(
            DeliveryJob(delivery_id=delivery.id, attempt_number=1)
        )
    assert outcome is Outcome.DELIVERED  # first live event goes to "Order service" (/hooks/ok)
    received = (
        await httpx.AsyncClient(transport=httpx.ASGITransport(app=app)).get("http://x/demo-receiver/requests")
    ).json()
    assert any(r["event_id"] == str(live.id) and r["signature_present"] for r in received)
