"""A tiny webhook receiver for local development, demos and E2E tests.

Run: uv run uvicorn app.dev.mock_receiver:app --port 9000

Point an endpoint at http://localhost:9000/hooks/<behaviour> (with
ALLOW_PRIVATE_DESTINATIONS=true in development):

  ok         200
  fail       500
  flaky      500 on attempt 1, then 200
  notfound   404 (not retried)
  ratelimit  429 with Retry-After: 40
  slow       sleeps past the delivery timeout
  switch     returns whatever POST /control/switch set (default 500)

If MOCK_RECEIVER_SECRET is set, signatures are verified and failures return 401.
GET /requests lists the most recent deliveries received.
"""

import asyncio
import os
from collections import deque
from datetime import UTC, datetime

from fastapi import FastAPI, Request, Response

from app.utils.signatures import verify_signature

app = FastAPI(title="Heimdall mock receiver")
received: deque[dict] = deque(maxlen=100)
state = {"switch": 500}
SECRET = os.environ.get("MOCK_RECEIVER_SECRET", "")


@app.post("/hooks/{behaviour}")
async def hook(behaviour: str, request: Request) -> Response:
    body = await request.body()
    headers = request.headers
    signature_ok = None
    if SECRET:
        signature_ok = verify_signature(
            SECRET, headers.get("x-webhook-timestamp", ""), body, headers.get("x-webhook-signature", "")
        )
    received.appendleft(
        {
            "received_at": datetime.now(UTC).isoformat(),
            "behaviour": behaviour,
            "event_id": headers.get("x-webhook-id"),
            "event_type": headers.get("x-webhook-event"),
            "attempt": headers.get("x-webhook-attempt"),
            "signature_present": "x-webhook-signature" in headers,
            "signature_valid": signature_ok,
            "bytes": len(body),
        }
    )
    if signature_ok is False:
        return Response('{"error":"bad signature"}', status_code=401, media_type="application/json")

    attempt = int(headers.get("x-webhook-attempt", "1") or 1)
    match behaviour:
        case "ok":
            return Response('{"received":true}', media_type="application/json")
        case "fail":
            return Response('{"error":"internal_error"}', status_code=500, media_type="application/json")
        case "flaky":
            if attempt == 1:
                return Response('{"error":"warming up"}', status_code=503, media_type="application/json")
            return Response('{"received":true}', media_type="application/json")
        case "notfound":
            return Response("<h1>404 Not Found</h1>", status_code=404, media_type="text/html")
        case "ratelimit":
            return Response('{"error":"slow down"}', status_code=429, headers={"Retry-After": "40"})
        case "slow":
            await asyncio.sleep(15)
            return Response("late")
        case "switch":
            code = state["switch"]
            return Response(f'{{"status":{code}}}', status_code=code, media_type="application/json")
    return Response('{"error":"unknown behaviour"}', status_code=404, media_type="application/json")


@app.post("/control/switch")
async def set_switch(status: int = 200) -> dict:
    state["switch"] = status
    return state


@app.get("/requests")
async def requests() -> list[dict]:
    return list(received)
