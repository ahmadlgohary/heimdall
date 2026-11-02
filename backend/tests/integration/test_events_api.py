from datetime import UTC, datetime, timedelta

from sqlalchemy import select, update

from app.db.models import Delivery, Event
from tests.conftest import create_endpoint, ingest, register


async def _seed(client, ready, n=5, event_type="order.created"):
    ids = []
    for i in range(n):
        res = await ingest(
            client, ready.endpoint["id"], ready.key, {"event_type": event_type, "data": {"i": i}}
        )
        ids.append(res.json()["event_id"])
    return ids


async def test_list_with_pagination_and_sort(client, ready):
    ids = await _seed(client, ready, 5)
    page1 = (await client.get("/api/v1/events?limit=2", headers=ready.account.headers)).json()
    assert page1["pagination"] == {"page": 1, "limit": 2, "total": 5, "total_pages": 3}
    assert [e["id"] for e in page1["items"]] == ids[::-1][:2]
    first = page1["items"][0]
    assert first["endpoint_name"] == "Orders" and first["attempts"] == 0 and first["status"] == "queued"
    asc = (await client.get("/api/v1/events?limit=2&sort=created_at", headers=ready.account.headers)).json()
    assert [e["id"] for e in asc["items"]] == ids[:2]


async def test_filters_and_search(client, db, ready):
    orders = await _seed(client, ready, 2, "order.created")
    invoices = await _seed(client, ready, 3, "invoice.paid")
    h = ready.account.headers

    by_type = (await client.get("/api/v1/events?event_type=invoice.paid", headers=h)).json()
    assert by_type["pagination"]["total"] == 3
    search = (await client.get("/api/v1/events?search=invoice", headers=h)).json()
    assert {e["id"] for e in search["items"]} == set(invoices)
    by_id = (
        await client.get(f"/api/v1/events?search=evt_{orders[0].replace('-', '')[:8]}", headers=h)
    ).json()
    assert [e["id"] for e in by_id["items"]] == [orders[0]]

    await db.execute(update(Event).where(Event.id == invoices[0]).values(status="failed"))
    await db.commit()
    failed = (await client.get("/api/v1/events?status=failed", headers=h)).json()
    assert [e["id"] for e in failed["items"]] == [invoices[0]]
    assert (await client.get("/api/v1/events?status=bogus", headers=h)).status_code == 422

    other = await create_endpoint(client, ready.account, url="https://other.example.com/x")
    await ingest(client, other["id"], ready.key)
    only_other = (await client.get(f"/api/v1/events?endpoint_id={other['id']}", headers=h)).json()
    assert only_other["pagination"]["total"] == 1

    future = (datetime.now(UTC) + timedelta(hours=1)).isoformat()
    none = (await client.get("/api/v1/events", params={"from": future}, headers=h)).json()
    assert none["items"] == []


async def test_detail_payload_and_deliveries(client, ready):
    (event_id,) = await _seed(client, ready, 1)
    h = ready.account.headers
    detail = (await client.get(f"/api/v1/events/{event_id}", headers=h)).json()
    assert detail["endpoint_url"] == ready.endpoint["url"] and detail["endpoint_enabled"] is True
    assert detail["latest_delivery"]["execution_number"] == 1

    payload = await client.get(f"/api/v1/events/{event_id}/payload", headers=h)
    assert payload.status_code == 200 and payload.headers["content-type"] == "application/json"
    assert payload.json()["id"] == event_id and payload.json()["data"] == {"i": 0}

    deliveries = (await client.get(f"/api/v1/events/{event_id}/deliveries", headers=h)).json()
    assert len(deliveries["items"]) == 1 and deliveries["items"][0]["trigger_type"] == "automatic"


async def test_events_are_private_to_their_owner(client, ready):
    (event_id,) = await _seed(client, ready, 1)
    bob = await register(client, "bob@example.com")
    for path in ["", "/payload", "/deliveries"]:
        res = await client.get(f"/api/v1/events/{event_id}{path}", headers=bob.headers)
        assert res.status_code == 404 and res.json()["error"]["code"] == "EVENT_NOT_FOUND"
    assert (await client.post(f"/api/v1/events/{event_id}/replay", headers=bob.headers)).status_code == 404
    assert (await client.get("/api/v1/events", headers=bob.headers)).json()["items"] == []


async def test_replay_creates_manual_execution_and_keeps_history(client, db, ready):
    (event_id,) = await _seed(client, ready, 1)
    h = ready.account.headers

    in_progress = await client.post(f"/api/v1/events/{event_id}/replay", headers=h)
    assert in_progress.status_code == 409 and in_progress.json()["error"]["code"] == "DELIVERY_IN_PROGRESS"

    await db.execute(
        update(Delivery).where(Delivery.event_id == event_id).values(status="failed", current_attempt=5)
    )
    await db.execute(update(Event).where(Event.id == event_id).values(status="failed"))
    await db.commit()

    res = await client.post(f"/api/v1/events/{event_id}/replay", headers=h)
    assert res.status_code == 202
    replay = res.json()
    assert (
        replay["execution_number"] == 2
        and replay["trigger_type"] == "manual"
        and replay["event_id"] == event_id
    )

    deliveries = (await client.get(f"/api/v1/events/{event_id}/deliveries", headers=h)).json()["items"]
    assert [d["execution_number"] for d in deliveries] == [2, 1]
    assert deliveries[1]["status"] == "failed"  # original history untouched
    detail = (await client.get(f"/api/v1/events/{event_id}", headers=h)).json()
    assert detail["status"] == "queued" and detail["id"] == event_id
    assert detail["latest_delivery"]["id"] == replay["id"]


async def test_replay_requires_enabled_endpoint(client, db, ready):
    (event_id,) = await _seed(client, ready, 1)
    await db.execute(update(Delivery).where(Delivery.event_id == event_id).values(status="delivered"))
    await db.commit()
    await client.patch(
        f"/api/v1/endpoints/{ready.endpoint['id']}", json={"enabled": False}, headers=ready.account.headers
    )
    res = await client.post(f"/api/v1/events/{event_id}/replay", headers=ready.account.headers)
    assert res.status_code == 409 and res.json()["error"]["code"] == "ENDPOINT_DISABLED"


async def test_delivery_detail_and_attempts(client, db, ready):
    (event_id,) = await _seed(client, ready, 1)
    delivery = await db.scalar(select(Delivery).where(Delivery.event_id == event_id))
    h = ready.account.headers
    detail = (await client.get(f"/api/v1/deliveries/{delivery.id}", headers=h)).json()
    assert detail["event_type"] == "order.created" and detail["endpoint_name"] == "Orders"
    attempts = (await client.get(f"/api/v1/deliveries/{delivery.id}/attempts", headers=h)).json()
    assert attempts["items"] == []
    bob = await register(client, "bob@example.com")
    assert (await client.get(f"/api/v1/deliveries/{delivery.id}", headers=bob.headers)).status_code == 404
