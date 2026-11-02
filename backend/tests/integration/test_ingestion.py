import json

import pytest
from sqlalchemy import func, select

from app.db.models import Delivery, Event, OutboxMessage
from tests.conftest import create_api_key, create_endpoint, ingest, register


async def count(db, model) -> int:
    return await db.scalar(select(func.count()).select_from(model))


async def test_valid_event_is_accepted_and_persisted(client, db, storage, ready):
    res = await ingest(client, ready.endpoint["id"], ready.key)
    assert res.status_code == 202, res.text
    body = res.json()
    assert body["status"] == "queued" and body["message"] == "Event accepted for delivery"

    event = await db.scalar(select(Event).where(Event.id == body["event_id"]))
    assert event.event_type == "order.created" and event.status == "queued"
    assert event.payload_key == f"events/{ready.account.id}/{ready.endpoint['id']}/{event.id}.json"

    stored = json.loads(storage.objects[event.payload_key])
    assert stored["id"] == str(event.id) and stored["type"] == "order.created"
    assert stored["data"] == {"order_id": "ORD-1001", "amount": 129.99}
    assert event.payload_size == len(storage.objects[event.payload_key])

    delivery = await db.scalar(select(Delivery).where(Delivery.event_id == event.id))
    assert (
        delivery.execution_number == 1
        and delivery.trigger_type == "automatic"
        and delivery.status == "queued"
    )
    outbox = await db.scalar(select(OutboxMessage).where(OutboxMessage.event_id == event.id))
    assert outbox.published_at is None
    assert outbox.payload == {"delivery_id": str(delivery.id), "attempt_number": 1, "not_before": None}


async def test_invalid_json_rejected(client, ready):
    res = await client.post(
        f"/api/v1/ingest/{ready.endpoint['id']}",
        content=b'{"event_type": "x",',
        headers={"Authorization": f"Bearer {ready.key}", "Content-Type": "application/json"},
    )
    assert res.status_code == 400 and res.json()["error"]["code"] == "INVALID_JSON"


async def test_schema_and_content_type_validation(client, ready):
    res = await ingest(client, ready.endpoint["id"], ready.key, {"data": {}})
    assert res.status_code == 422 and res.json()["error"]["details"][0]["field"] == "event_type"
    res = await ingest(client, ready.endpoint["id"], ready.key, {"event_type": "bad type!", "data": {}})
    assert res.status_code == 422
    res = await client.post(
        f"/api/v1/ingest/{ready.endpoint['id']}",
        content=b"event_type=x",
        headers={"Authorization": f"Bearer {ready.key}", "Content-Type": "application/x-www-form-urlencoded"},
    )
    assert res.status_code == 415


async def test_missing_invalid_and_revoked_keys_rejected(client, ready):
    url = f"/api/v1/ingest/{ready.endpoint['id']}"
    missing = await client.post(url, json={"event_type": "x"})
    assert missing.status_code == 401 and missing.json()["error"]["code"] == "API_KEY_MISSING"
    invalid = await client.post(
        url, json={"event_type": "x"}, headers={"Authorization": "Bearer wh_live_nope"}
    )
    assert invalid.status_code == 401 and invalid.json()["error"]["code"] == "API_KEY_INVALID"
    jwt_instead = await client.post(url, json={"event_type": "x"}, headers=ready.account.headers)
    assert jwt_instead.status_code == 401

    keys = (await client.get("/api/v1/api-keys", headers=ready.account.headers)).json()["items"]
    await client.delete(f"/api/v1/api-keys/{keys[0]['id']}", headers=ready.account.headers)
    assert (await ingest(client, ready.endpoint["id"], ready.key)).status_code == 401


async def test_key_cannot_target_another_users_endpoint(client, ready):
    mallory = await register(client, "mallory@example.com")
    mallory_key = await create_api_key(client, mallory)
    res = await ingest(client, ready.endpoint["id"], mallory_key)
    assert res.status_code == 404 and res.json()["error"]["code"] == "ENDPOINT_NOT_FOUND"


async def test_disabled_endpoint_rejects_ingestion(client, db, ready):
    await client.patch(
        f"/api/v1/endpoints/{ready.endpoint['id']}", json={"enabled": False}, headers=ready.account.headers
    )
    res = await ingest(client, ready.endpoint["id"], ready.key)
    assert res.status_code == 409 and res.json()["error"]["code"] == "ENDPOINT_DISABLED"
    assert await count(db, Event) == 0


async def test_duplicate_idempotency_key_returns_original_event(client, db, ready):
    first = await ingest(client, ready.endpoint["id"], ready.key, idempotency_key="order-12345")
    second = await ingest(client, ready.endpoint["id"], ready.key, idempotency_key="order-12345")
    assert first.status_code == 202 and second.status_code == 200
    assert second.headers["idempotent-replayed"] == "true"
    assert first.json()["event_id"] == second.json()["event_id"]
    assert await count(db, Event) == 1 and await count(db, OutboxMessage) == 1

    conflict = await ingest(
        client,
        ready.endpoint["id"],
        ready.key,
        {"event_type": "order.created", "data": {"x": 1}},
        idempotency_key="order-12345",
    )
    assert conflict.status_code == 409 and conflict.json()["error"]["code"] == "IDEMPOTENCY_CONFLICT"

    # keys are scoped per endpoint
    other = await create_endpoint(client, ready.account, url="https://other.example.com/x")
    assert (await ingest(client, other["id"], ready.key, idempotency_key="order-12345")).status_code == 202


async def test_payload_size_limit_enforced(client, db, ready, settings):
    big = {"event_type": "bulk.import", "data": {"blob": "x" * settings.max_payload_bytes}}
    res = await ingest(client, ready.endpoint["id"], ready.key, big)
    assert res.status_code == 413 and res.json()["error"]["code"] == "PAYLOAD_TOO_LARGE"
    assert await count(db, Event) == 0


async def test_storage_failure_does_not_accept_event(client, db, storage, ready):
    storage.fail = True
    res = await ingest(client, ready.endpoint["id"], ready.key)
    assert res.status_code == 502 and res.json()["error"]["code"] == "STORAGE_UNAVAILABLE"
    assert await count(db, Event) == 0 and await count(db, OutboxMessage) == 0


async def test_event_and_outbox_are_atomic(client, db, storage, ready, monkeypatch):
    from app.services import event_service

    def boom(*args, **kwargs):
        raise RuntimeError("outbox write failed")

    monkeypatch.setattr(event_service, "queue_delivery", boom)
    with pytest.raises(RuntimeError):
        await ingest(client, ready.endpoint["id"], ready.key)
    assert await count(db, Event) == 0 and await count(db, OutboxMessage) == 0
    assert storage.objects == {}  # archived payload cleaned up


async def test_internal_route_requires_worker_secret(client, db, ready):
    url = f"/api/v1/internal/ingest/{ready.endpoint['id']}"
    body = {"event_type": "edge.event", "data": {}}
    auth = {"Authorization": f"Bearer {ready.key}"}
    assert (await client.post(url, json=body, headers=auth)).status_code == 401
    assert (
        await client.post(url, json=body, headers={**auth, "X-Worker-Secret": "wrong"})
    ).status_code == 401
    ok = await client.post(url, json=body, headers={**auth, "X-Worker-Secret": "test-worker-secret"})
    assert ok.status_code == 202
    assert await count(db, Event) == 1


async def test_api_key_last_used_is_recorded(client, ready):
    await ingest(client, ready.endpoint["id"], ready.key)
    keys = (await client.get("/api/v1/api-keys", headers=ready.account.headers)).json()["items"]
    assert keys[0]["last_used_at"] is not None
    assert "key" not in keys[0] and keys[0]["key_prefix"] == ready.key[:12]
