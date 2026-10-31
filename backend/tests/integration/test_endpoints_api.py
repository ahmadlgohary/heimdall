import httpx
from sqlalchemy import select

from app.core.security import SecretBox
from app.db.models import Endpoint, Event
from tests.conftest import create_endpoint, register


async def test_create_returns_secret_once_and_encrypts_it(client, db, settings):
    account = await register(client)
    created = await create_endpoint(client, account, description="Production order notifications")
    assert created["signing_secret"].startswith("whsec_")
    assert created["enabled"] is True

    fetched = (await client.get(f"/api/v1/endpoints/{created['id']}", headers=account.headers)).json()
    assert "signing_secret" not in fetched
    assert fetched["stats"] == {"total_events": 0, "success_rate": None, "last_event_at": None}

    row = await db.scalar(select(Endpoint).where(Endpoint.id == created["id"]))
    assert row.signing_secret_encrypted != created["signing_secret"]
    assert SecretBox(settings.fernet_key).decrypt(row.signing_secret_encrypted) == created["signing_secret"]


async def test_invalid_and_private_urls_rejected(client):
    account = await register(client)
    for url, fragment in [
        ("not a url", "https://"),
        ("https://127.0.0.1/hook", "Private"),
        ("https://169.254.169.254/latest", "Private"),
        ("https://svc.internal-dns.test/hook", "private"),
    ]:
        res = await client.post("/api/v1/endpoints", json={"name": "x", "url": url}, headers=account.headers)
        assert res.status_code == 422, url
        err = res.json()["error"]
        assert err["code"] == "INVALID_URL" and fragment in err["message"], (url, err)


async def test_http_rejected_when_https_required(app_factory):
    from cryptography.fernet import Fernet

    app = app_factory(
        app_env="production", encryption_key=Fernet.generate_key().decode(), cookie_secure=False
    )
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as c:
        account = await register(c, "prod@example.com")
        res = await c.post(
            "/api/v1/endpoints",
            json={"name": "x", "url": "http://hooks.example.com/x"},
            headers=account.headers,
        )
        assert res.status_code == 422 and "HTTPS" in res.json()["error"]["message"]
        ok = await c.post(
            "/api/v1/endpoints",
            json={"name": "x", "url": "https://hooks.example.com/x"},
            headers=account.headers,
        )
        assert ok.status_code == 201


async def test_update_and_disable(client):
    account = await register(client)
    ep = await create_endpoint(client, account)
    res = await client.patch(
        f"/api/v1/endpoints/{ep['id']}",
        json={"name": "Renamed", "enabled": False, "description": "  "},
        headers=account.headers,
    )
    assert res.status_code == 200
    body = res.json()
    assert body["name"] == "Renamed" and body["enabled"] is False and body["description"] is None
    bad = await client.patch(
        f"/api/v1/endpoints/{ep['id']}", json={"url": "https://localhost/x"}, headers=account.headers
    )
    assert bad.status_code == 422


async def test_delete(client, db):
    account = await register(client)
    ep = await create_endpoint(client, account)
    assert (await client.delete(f"/api/v1/endpoints/{ep['id']}", headers=account.headers)).status_code == 204
    assert (await client.get(f"/api/v1/endpoints/{ep['id']}", headers=account.headers)).status_code == 404
    assert await db.scalar(select(Endpoint).where(Endpoint.id == ep["id"])) is None


async def test_users_cannot_touch_other_users_endpoints(client):
    alice = await register(client, "alice@example.com")
    bob = await register(client, "bob@example.com")
    ep = await create_endpoint(client, alice)
    path = f"/api/v1/endpoints/{ep['id']}"
    for method, suffix, body in [
        ("GET", "", None),
        ("PATCH", "", {"name": "pwned"}),
        ("DELETE", "", None),
        ("POST", "/rotate-secret", None),
        ("POST", "/test", None),
    ]:
        res = await client.request(method, path + suffix, json=body, headers=bob.headers)
        assert res.status_code == 404, (method, suffix)
        assert res.json()["error"]["code"] == "ENDPOINT_NOT_FOUND"
    listed = (await client.get("/api/v1/endpoints", headers=bob.headers)).json()
    assert listed["items"] == [] and listed["pagination"]["total"] == 0


async def test_rotation_invalidates_old_secret(client, db, settings):
    account = await register(client)
    ep = await create_endpoint(client, account)
    res = await client.post(f"/api/v1/endpoints/{ep['id']}/rotate-secret", headers=account.headers)
    assert res.status_code == 200
    new = res.json()["signing_secret"]
    assert new != ep["signing_secret"]
    row = await db.scalar(select(Endpoint).where(Endpoint.id == ep["id"]))
    await db.refresh(row)
    assert SecretBox(settings.fernet_key).decrypt(row.signing_secret_encrypted) == new


async def test_send_test_event(client, db, storage):
    account = await register(client)
    ep = await create_endpoint(client, account)
    res = await client.post(f"/api/v1/endpoints/{ep['id']}/test", headers=account.headers)
    assert res.status_code == 202
    event = await db.scalar(select(Event).where(Event.id == res.json()["event_id"]))
    assert event.event_type == "heimdall.test" and event.payload_key in storage.objects

    await client.patch(f"/api/v1/endpoints/{ep['id']}", json={"enabled": False}, headers=account.headers)
    disabled = await client.post(f"/api/v1/endpoints/{ep['id']}/test", headers=account.headers)
    assert disabled.status_code == 409 and disabled.json()["error"]["code"] == "ENDPOINT_DISABLED"


async def test_list_is_paginated_with_stats(client):
    account = await register(client)
    for i in range(3):
        await client.post(
            "/api/v1/endpoints",
            json={"name": f"ep{i}", "url": f"https://h{i}.example.com/x"},
            headers=account.headers,
        )
    page = (await client.get("/api/v1/endpoints?limit=2&page=2", headers=account.headers)).json()
    assert page["pagination"] == {"page": 2, "limit": 2, "total": 3, "total_pages": 2}
    assert len(page["items"]) == 1 and page["items"][0]["stats"]["total_events"] == 0
    too_big = await client.get("/api/v1/endpoints?limit=101", headers=account.headers)
    assert too_big.status_code == 422
