# Heimdall edge ingestion worker

A Cloudflare Worker that serves as the public, serverless entry point for events
(plan §7):

```
POST https://ingest.<your-domain>/{endpoint_id}
Authorization: Bearer wh_live_...
Content-Type: application/json
Idempotency-Key: order-12345        (optional)

{"event_type": "order.created", "data": {...}}
```

It is **not** a second event processor. Its job is to:

1. **Check at the edge:** method and route (`POST /{uuid}`), `Content-Type`,
   the API key's format, the `Idempotency-Key` length, the 256 KB size limit
   (from `Content-Length` and from the actual stream), and the body shape
   (a JSON object with a valid `event_type`). Bad requests are rejected before
   they reach the API.
2. **Forward** the original bytes, unchanged, to the API's
   `POST /api/v1/internal/ingest/{endpoint_id}`. It adds the shared secret
   (`X-Worker-Secret`) and passes along the caller's API key, Idempotency-Key,
   IP (`X-Forwarded-For`) and request ID.
3. **Relay** the API's response: status, body, `Idempotent-Replayed`,
   `Retry-After` and `X-Request-ID`. Other upstream headers aren't passed on.
4. **Fail cleanly** when the API can't be reached:

   | Situation | Response |
   | --- | --- |
   | Network error or non-JSON origin error | `502 UPSTREAM_UNAVAILABLE` |
   | No response within 10 s | `504 UPSTREAM_TIMEOUT` |
   | Wrong shared secret, or the internal route disabled | `502 GATEWAY_MISCONFIGURED`, logged, details not exposed |

The API still authenticates the key and owns persistence, idempotency and
queuing. Errors use the API's format: `{"error": {"code", "message", "details"}}`.

## Configuration

| Name | Where | Purpose |
| --- | --- | --- |
| `API_ORIGIN` | `wrangler.toml` `[vars]` / `[env.production.vars]` | Base URL of the FastAPI service |
| `MAX_BODY_BYTES` | `wrangler.toml` | Body size limit, 262144 (256 KB) by default |
| `UPSTREAM_TIMEOUT_MS` | `wrangler.toml` | API timeout, 10000 by default |
| `WORKER_SHARED_SECRET` | **secret** | Must equal `WORKER_SHARED_SECRET` in the API's environment |

The secret never goes in `wrangler.toml` or git:

```bash
npx wrangler secret put WORKER_SHARED_SECRET --env production
```

## Develop

```bash
npm ci
cp .dev.vars.example .dev.vars        # put the API's WORKER_SHARED_SECRET here
npm run dev                           # http://localhost:8787, forwards to API_ORIGIN
# or from the repo root, in front of the docker compose API:
make worker-dev
```

```bash
curl -X POST http://localhost:8787/<endpoint_id> \
  -H "Authorization: Bearer <api_key>" -H "Content-Type: application/json" \
  -d '{"event_type":"order.created","data":{"order_id":"ORD-1001"}}'
```

After changing `wrangler.toml`, run `npm run types` to regenerate
`worker-configuration.d.ts`. CI fails if it's out of date.

## Test

```bash
npm test          # Vitest inside workerd, the Workers runtime (@cloudflare/vitest-plugin)
npm run typecheck
```

The 21 tests cover forwarding (exact bytes and headers), relaying of API
errors and replays, every edge validation, the streamed size limit, routing,
and each way the upstream can fail. The request handler takes the upstream
`fetch` as a parameter, so tests run against a fake API inside the real
runtime. Two tests go through the worker's real entry point with the
`wrangler.toml` bindings.

## Deploy

1. Set your domain in `wrangler.toml` under `[env.production]`: the
   `routes` pattern and `API_ORIGIN`.
2. Set the secret: `npx wrangler secret put WORKER_SHARED_SECRET --env production`.
3. Make sure the API has the same `WORKER_SHARED_SECRET`. If it's empty, the
   internal route is disabled.
4. Run `npm run deploy` (or `make worker-deploy` from the repo root).
