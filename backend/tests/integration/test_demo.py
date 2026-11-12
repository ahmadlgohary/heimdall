"""Demo environment: seed script, fixture labelling, demo account guards, built-in receiver."""

import uuid

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
        "sandbox_minutes": demo_settings.demo_sandbox_ttl_minutes,
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
    assert (await client.get("/api/v1/demo")).json() == {
        "enabled": False,
        "email": None,
        "password": None,
        "sandbox_minutes": None,
    }
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


async def test_receiver_returns_full_deliveries_by_event_id(demo_client):
    client, _ = demo_client
    headers = {
        "X-Webhook-ID": "evt-123",
        "X-Webhook-Attempt": "1",
        "X-Webhook-Timestamp": "1794312000",
        "X-Webhook-Signature": "v1=abc",
    }
    await client.post("/demo-receiver/hooks/ok", content=b'{"id":"evt-123"}', headers=headers)
    (got,) = (await client.get("/demo-receiver/requests/evt-123")).json()
    assert (
        got["body"] == '{"id":"evt-123"}'
        and got["signature"] == "v1=abc"
        and got["timestamp"] == "1794312000"
    )
    assert (await client.get("/demo-receiver/requests/unknown")).status_code == 404
    # the shared list never carries bodies or signatures
    assert all(
        "body" not in r and "signature" not in r for r in (await client.get("/demo-receiver/requests")).json()
    )


# ---------- private demo copies ----------

from datetime import UTC, datetime, timedelta  # noqa: E402

from sqlalchemy import text, update  # noqa: E402

from app.services.demo_service import SANDBOX_DOMAIN, sweep_expired  # noqa: E402


async def demo_login(app, settings):
    """Sign in to the demo as a fresh browser. Returns an unopened client holding that session."""
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as tmp:
        res = await tmp.post(
            "/api/v1/auth/login", json={"email": settings.demo_email, "password": settings.demo_password}
        )
        assert res.status_code == 200, res.text
        cookies = tmp.cookies
    body = res.json()
    client = httpx.AsyncClient(transport=transport, base_url="http://test", cookies=cookies)
    return client, {"Authorization": f"Bearer {body['access_token']}"}, body["user"]


async def template_fingerprint(db, email):
    """Everything the template owns, hashed: proves visitors never touch it."""
    sql = text(
        """
        SELECT md5(string_agg(x, '|' ORDER BY x)) FROM (
          SELECT u::text AS x FROM users u WHERE u.email = :e
          UNION ALL SELECT ep::text FROM endpoints ep JOIN users u ON u.id = ep.user_id WHERE u.email = :e
          UNION ALL SELECT k::text FROM api_keys k JOIN users u ON u.id = k.user_id WHERE u.email = :e
          UNION ALL SELECT ev::text FROM events ev JOIN endpoints ep ON ep.id = ev.endpoint_id
                    JOIN users u ON u.id = ep.user_id WHERE u.email = :e
          UNION ALL SELECT d::text FROM deliveries d JOIN events ev ON ev.id = d.event_id
                    JOIN endpoints ep ON ep.id = ev.endpoint_id
                    JOIN users u ON u.id = ep.user_id WHERE u.email = :e
        ) t
        """
    )
    return (await db.execute(sql, {"e": email})).scalar()


@pytest.fixture
async def seeded(demo_client, demo_settings, session_factory, storage, db):
    _, app = demo_client
    await run_seed(demo_settings, session_factory, storage, events=40, live=0)
    return app


async def test_each_demo_sign_in_gets_a_private_copy(seeded, demo_settings, db):
    before = await template_fingerprint(db, demo_settings.demo_email)
    a, ha, user_a = await demo_login(seeded, demo_settings)
    b, hb, user_b = await demo_login(seeded, demo_settings)
    async with a, b:
        assert user_a["is_demo"] and user_b["is_demo"] and user_a["id"] != user_b["id"]
        assert user_a["email"].endswith(SANDBOX_DOMAIN) and user_a["demo_expires_at"]
        events_a = (await a.get("/api/v1/events?limit=1", headers=ha)).json()
        assert events_a["pagination"]["total"] == 40
        assert (await b.get("/api/v1/events?limit=1", headers=hb)).json()["pagination"]["total"] == 40

        # A changes things...
        eps_a = (await a.get("/api/v1/endpoints", headers=ha)).json()["items"]
        await a.patch(f"/api/v1/endpoints/{eps_a[0]['id']}", json={"name": "Renamed by A"}, headers=ha)
        created = await a.post(
            "/api/v1/endpoints", json={"name": "A's own", "url": "https://hooks.example.com/a"}, headers=ha
        )
        assert created.status_code == 201
        # ...B sees none of it, and can't reach A's resources
        names_b = [e["name"] for e in (await b.get("/api/v1/endpoints", headers=hb)).json()["items"]]
        assert "Renamed by A" not in names_b and "A's own" not in names_b
        assert (await b.get(f"/api/v1/endpoints/{eps_a[0]['id']}", headers=hb)).status_code == 404
    assert await template_fingerprint(db, demo_settings.demo_email) == before


async def test_a_copy_is_fully_interactive(seeded, demo_settings, storage):
    a, h, _ = await demo_login(seeded, demo_settings)
    async with a:
        endpoints = (await a.get("/api/v1/endpoints", headers=h)).json()["items"]
        enabled = next(e for e in endpoints if e["enabled"])
        assert (await a.post(f"/api/v1/endpoints/{enabled['id']}/test", headers=h)).status_code == 202
        failed = (await a.get("/api/v1/events?status=failed&limit=1", headers=h)).json()["items"]
        if failed and next(e for e in endpoints if e["id"] == failed[0]["endpoint_id"])["enabled"]:
            replay = await a.post(f"/api/v1/events/{failed[0]['id']}/replay", headers=h)
            assert replay.status_code == 202  # reads the shared sample payload
        key = (await a.post("/api/v1/api-keys", json={"name": "mine"}, headers=h)).json()["key"]
        sent = await a.post(
            f"/api/v1/ingest/{enabled['id']}",
            json={"event_type": "order.created", "data": {"n": 1}},
            headers={"Authorization": f"Bearer {key}"},
        )
        assert sent.status_code == 202
        payload = await a.get(f"/api/v1/events/{sent.json()['event_id']}/payload", headers=h)
        assert payload.status_code == 200


async def test_sign_out_deletes_the_copy_but_not_shared_payloads(seeded, demo_settings, storage, db):
    shared = set(storage.objects)
    a, h, user = await demo_login(seeded, demo_settings)
    async with a:
        enabled = next(
            e for e in (await a.get("/api/v1/endpoints", headers=h)).json()["items"] if e["enabled"]
        )
        await a.post(f"/api/v1/endpoints/{enabled['id']}/test", headers=h)
        own = {k for k in storage.objects if k.startswith(f"events/{user['id']}/")}
        assert len(own) == 1
        assert (await a.post("/api/v1/auth/logout", headers=h)).status_code == 204
        assert (await a.post("/api/v1/auth/refresh")).status_code == 401
    assert await db.scalar(select(User).where(User.id == uuid.UUID(user["id"]))) is None
    assert not (own & set(storage.objects))  # what the visitor created is gone
    assert shared <= set(storage.objects)  # the template's payloads are untouched


async def test_deleting_a_copied_endpoint_keeps_shared_payloads(seeded, demo_settings, storage):
    shared = set(storage.objects)
    a, h, _ = await demo_login(seeded, demo_settings)
    async with a:
        for e in (await a.get("/api/v1/endpoints", headers=h)).json()["items"]:
            assert (await a.delete(f"/api/v1/endpoints/{e['id']}", headers=h)).status_code == 204
    assert shared <= set(storage.objects)
    b, hb, _ = await demo_login(seeded, demo_settings)  # the next visitor still gets everything
    async with b:
        event = (await b.get("/api/v1/events?limit=1", headers=hb)).json()["items"][0]
        assert (await b.get(f"/api/v1/events/{event['id']}/payload", headers=hb)).status_code == 200


async def test_expired_copies_are_refused_then_swept(seeded, demo_settings, session_factory, storage, db):
    a, h, user = await demo_login(seeded, demo_settings)
    async with a:
        await db.execute(
            update(User).where(User.id == uuid.UUID(user["id"])).values(demo_expires_at=datetime.now(UTC))
        )
        await db.commit()
        me = await a.get("/api/v1/auth/me", headers=h)
        assert me.status_code == 401 and me.json()["error"]["code"] == "DEMO_EXPIRED"
        assert (await a.post("/api/v1/auth/refresh")).status_code == 401
    assert await sweep_expired(session_factory, storage) == 1
    assert await db.scalar(select(User).where(User.id == uuid.UUID(user["id"]))) is None


async def test_copies_look_recent_even_from_an_old_template(seeded, demo_settings, db):
    # age the template's history by 10 days
    await db.execute(text("UPDATE events SET created_at = created_at - interval '10 days'"))
    await db.execute(text("UPDATE delivery_attempts SET attempted_at = attempted_at - interval '10 days'"))
    await db.commit()
    a, h, _ = await demo_login(seeded, demo_settings)
    async with a:
        newest = (await a.get("/api/v1/events?limit=1", headers=h)).json()["items"][0]["created_at"]
        age = datetime.now(UTC) - datetime.fromisoformat(newest)
        assert timedelta(minutes=50) < age < timedelta(minutes=70)
        stats = (await a.get("/api/v1/dashboard/stats?range=24h", headers=h)).json()
        assert stats["total_events"] > 0


async def test_copies_are_capped(demo_settings, session_factory, storage, db):
    capped = demo_settings.model_copy(update={"demo_max_sandboxes": 1})
    app = create_app(capped, storage=storage)
    app.state.session_factory = session_factory
    await run_seed(capped, session_factory, storage, events=5, live=0)
    a, _, _ = await demo_login(app, capped)
    async with a, httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as b:
        busy = await b.post(
            "/api/v1/auth/login", json={"email": capped.demo_email, "password": capped.demo_password}
        )
        assert busy.status_code == 429 and busy.json()["error"]["code"] == "DEMO_BUSY"


async def test_reseeding_ends_active_copies(seeded, demo_settings, session_factory, storage, db):
    a, _, user = await demo_login(seeded, demo_settings)
    await a.aclose()
    await run_seed(demo_settings, session_factory, storage, events=10, live=0)
    assert await db.scalar(select(User).where(User.id == uuid.UUID(user["id"]))) is None


async def test_demo_info_reports_the_time_limit(demo_client, demo_settings):
    client, _ = demo_client
    info = (await client.get("/api/v1/demo")).json()
    assert info["sandbox_minutes"] == demo_settings.demo_sandbox_ttl_minutes
