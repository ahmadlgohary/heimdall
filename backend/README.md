# Heimdall backend

The backend has three processes, all from one codebase and one image:

| Process | Command | Job |
| --- | --- | --- |
| API | `uvicorn app.main:app` | Auth, endpoints, ingestion, events, analytics |
| Outbox publisher | `python -m app.workers.outbox_worker` | Relays committed outbox rows to RabbitMQ; re-queues stalled deliveries |
| Delivery worker | `python -m app.workers.delivery_worker` | Consumes jobs, signs and sends webhooks, records attempts, schedules retries |

Stack: Python 3.14, FastAPI, SQLAlchemy 2 (async, asyncpg), Alembic,
PostgreSQL 16 and object storage on Neon in production (S3 API via boto3), RabbitMQ (aio-pika), PyJWT, Argon2id
(pwdlib), httpx, pytest and Ruff. Dependencies are managed with **uv**.

## Run with Docker (recommended)

From the repository root:

```bash
make up       # creates .env with fresh secrets on first run, builds, starts everything
make smoke    # ingest an event and check it is delivered end to end
make test     # backend test suite inside the api container (own test DB and vhost)
make help     # every command
```

`docker-compose.yml` runs PostgreSQL, RabbitMQ, the migrations (as a one-shot
service), the API, the publisher, the worker, the mock receiver, and the
frontend. The frontend's nginx proxies `/api` to the API, so the app is served
from one origin. Point endpoints at `http://mock-receiver:9000/hooks/ok`.
Host ports are configurable in `.env` (`POSTGRES_PORT`, `API_PORT`, ...).

`docker-compose.prod.yml` is the production variant. It uses Neon for
Postgres and S3-compatible storage from `.env`, sets `APP_ENV=production`,
runs no dev tools, and publishes only the frontend.

## Run locally without Docker for the app

You need PostgreSQL and RabbitMQ running (the repo-level Docker Compose will
provide both).

Configuration lives in **one file, the repository root's `.env`**, shared with
docker compose. The backend finds it from any working directory (`make env` at
the root creates it from `.env.example` with fresh secrets).

```bash
uv sync
(cd .. && make env)             # once: creates ../.env; STORAGE_BACKEND=local needs no S3
uv run alembic upgrade head
uv run uvicorn app.main:app --reload --port 8000
uv run python -m app.workers.outbox_worker      # second terminal
uv run python -m app.workers.delivery_worker    # third terminal
```

The frontend dev server proxies `/api` to port 8000, so `npm run dev` in
`frontend/` works against it directly. Interactive API docs are at
http://localhost:8000/docs.

### Built-in mock receiver

To test deliveries without a real server:

```bash
uv run uvicorn app.dev.mock_receiver:app --port 9000
```

Set `ALLOW_PRIVATE_DESTINATIONS=true` in development, then point an endpoint
at `http://127.0.0.1:9000/hooks/<behaviour>`:

| Behaviour | Response |
| --- | --- |
| `ok` | 200 |
| `fail` | 500 |
| `flaky` | 503 on the first attempt, then 200 |
| `notfound` | 404, not retried |
| `ratelimit` | 429 with `Retry-After: 40` |
| `slow` | Exceeds the delivery timeout |
| `switch` | Whatever status you last set with `POST /control/switch?status=200` |

`GET /requests` shows what it received.

## Payload storage (S3-compatible)

Payloads go to an S3-compatible bucket. In production that's Neon object
storage; plain Amazon S3 works too. Set `STORAGE_BACKEND=s3` and
`S3_BUCKET_NAME`, plus the four variables Neon provides (the standard AWS SDK
names):

| Variable | |
| --- | --- |
| `AWS_ENDPOINT_URL_S3` | Neon's storage endpoint. Leave empty for Amazon S3 itself |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | Set both, or neither to use AWS's default credential chain |
| `AWS_REGION` | Defaults to `us-east-1` |

- **Object layout:** payloads are stored at
  `events/{user_id}/{endpoint_id}/{event_id}.json` with
  `Content-Type: application/json`.
- **Privacy:** the bucket stays private. The API is the only reader, and the
  browser never sees credentials or bucket URLs.
- **Encryption at rest:** `ServerSideEncryption: AES256` is sent on Amazon S3
  and left off for custom endpoints, because many S3-compatible services
  reject that header. Override this with `S3_SERVER_SIDE_ENCRYPTION`.
- **Addressing:** `S3_FORCE_PATH_STYLE=true` is only needed for path-style
  services like MinIO.

## Database on Neon

Paste Neon's connection strings as they are. The `postgres://` scheme,
`sslmode=require` and `channel_binding` are translated for asyncpg
automatically.

- **App:** use the pooled host (`...-pooler...`) as `DATABASE_URL`. Pooled
  hosts are detected by name, and asyncpg's prepared-statement cache is
  switched off for them, because PgBouncer in transaction mode can't keep
  prepared statements. Force this either way with `DATABASE_USES_POOLER`.
- **Migrations:** `alembic upgrade head` uses `DATABASE_URL` too. That works
  through the pooled host, as the session's migrations to Neon did.

## Tests

```bash
uv run pytest                       # unit tests always; integration when services are reachable
uv run pytest --cov                 # coverage report
uv run ruff check . && uv run ruff format --check .
```

Integration tests use real PostgreSQL and RabbitMQ:

```bash
TEST_DATABASE_URL=postgresql+asyncpg://heimdall:heimdall@localhost:5432/heimdall_test \
TEST_RABBITMQ_URL=amqp://guest:guest@localhost:5672/heimdall_test \
uv run pytest
```

Give the tests their own RabbitMQ vhost (`rabbitmqctl add_vhost heimdall_test`).
Otherwise a dev worker running against the same vhost consumes the tests'
messages and makes them fail.

The test database is dropped and rebuilt with the real Alembic migrations at
session start, so the migrations are tested too. HTTP destinations are always
mocked. If a service is unreachable, its tests are skipped rather than failed.

The suite has 135 tests at 92% line coverage. They cover the spec's §11.2 and
§11.3 lists, including:
- **Auth:** refresh-token rotation and reuse detection.
- **Ownership:** every private resource is checked against its owner.
- **Ingestion:** idempotency (both replay and conflict), the 256 KB limit, and storage outages.
- **Atomicity:** the event and its outbox entry are written together or not at all.
- **Signing:** HMAC signatures checked against an independent implementation.
- **Retries:** backoff and Retry-After.
- **Duplicates:** duplicate and concurrent messages never record a second attempt.
- **Crash recovery:** a publisher crash and recovery still yields exactly one attempt.
- **Dead letters:** dead-lettered messages can be inspected.
- **SSRF:** DNS rebinding is caught at delivery time.
- **End to end:** ingest → RabbitMQ → worker → destination.

## How delivery works

1. `POST /api/v1/ingest/{endpoint_id}` authenticates the API key, checks
   endpoint ownership and status, enforces the 256 KB limit and validates the
   body.
2. The JSON envelope `{id, type, created_at, data}` is written to storage at
   `events/{user}/{endpoint}/{event}.json`. If that fails, the API returns
   `502` and nothing is persisted.
3. The event, delivery execution 1, and an **outbox** row are committed in one
   transaction. The API then returns `202`. If the commit fails, the archived
   object is deleted.
4. The publisher locks unpublished rows (`FOR UPDATE SKIP LOCKED`), publishes
   persistent messages with publisher confirms, and marks the rows published.
5. The worker **claims** the attempt with a row-locked transition and a lease,
   then sends the stored bytes, signed:
   `X-Webhook-Signature: v1=HMAC_SHA256(secret, "{timestamp}.{body}")`. The
   claim prevents two workers from sending the same attempt.
6. The worker records the attempt, updates the delivery and event status, and
   writes any retry to the outbox, all in one transaction. Only then does it
   ack the message.
7. Retries wait in TTL queues (5 s, 30 s, 2 min, 8 min, 30 min tiers) that
   dead-letter back into the work queue. No worker ever sleeps.

**Delivery semantics** are at-least-once. Receivers should dedupe on
`X-Webhook-ID`. The unique `(delivery_id, attempt_number)` constraint
guarantees one recorded result per attempt.

**Retry policy:**

| | |
| --- | --- |
| Attempts | 5 maximum |
| Delay | `min(30 × 4^(n−2), 1800)` seconds: 30 s, 2 min, 8 min, 30 min |
| Retried | Timeouts, connection errors, 408, 425, 429 and 5xx |
| Not retried | Other 4xx responses and redirects (redirects are never followed) |
| `Retry-After` | Honoured on 429 |

**Safety nets:**
- **Lost messages:** the publisher's sweeper re-queues deliveries whose
  message seems lost: a retry overdue by 2 minutes, a delivery queued for over
  2 minutes, or an expired lease.
- **Poison messages:** messages that can't be parsed, or that fail twice, go
  to `heimdall.deliveries.dead` for inspection.

**SSRF protection:**
- **At creation:** URLs are checked and the host is resolved. Loopback,
  private, link-local, CGNAT and metadata addresses are rejected.
- **At delivery:** every attempt re-resolves the host and connects to the
  vetted IP, with the original Host header and SNI, which closes the
  DNS-rebinding hole.
- **Requests:** redirects are disabled, there is a 10 s total timeout, ambient
  proxies are ignored, and stored response bodies are capped at 16 KB.

## Security notes

- **Passwords:** hashed with Argon2id. Login runs a dummy verification for
  unknown emails, so response time doesn't reveal which accounts exist.
- **Access tokens:** 15-minute JWTs, kept in frontend memory only.
- **Refresh tokens:** opaque values stored as hashes, in an HttpOnly cookie
  scoped to `/api/v1/auth`. They rotate on every use. Reusing a rotated token
  revokes that whole login's token family.
- **API keys:** 256-bit random values, stored as SHA-256 hashes and shown once.
- **Signing secrets:** encrypted at rest (Fernet), shown only at creation or
  rotation.
- **Ownership:** checked on every query. Other users' resources return `404`,
  so their existence isn't revealed.
- **Rate limits:** applied to the auth routes (per IP) and ingestion (per key).
- **Logs:** structured JSON, with keys that look like secrets redacted, and no
  query strings or payloads.

## API notes and deviations from the spec

- **Error format:** errors use the spec's `{"error": {"code", "message", "details"}}` shape.
- **Extra routes:** `POST /auth/change-password` and `GET /analytics/overview`
  are added for the frontend's settings and analytics pages.
- **Ingestion responses:** the first submission returns `202`. A repeat with
  the same `Idempotency-Key` and the same payload returns `200` with
  `Idempotent-Replayed: true`. The same key with a different payload returns
  `409 IDEMPOTENCY_CONFLICT`.
- **Disabled endpoints:** ingestion and replay return `409 ENDPOINT_DISABLED`.
  Replaying while a delivery is still running returns `409 DELIVERY_IN_PROGRESS`.
- **Retry schedule:** the spec's table lists 10 minutes for attempt 4, but its
  formula gives 8 minutes. The formula is implemented.
- **Endpoints whose DNS doesn't resolve yet** are accepted at creation, because
  delivery re-validates them anyway.

## Known limitations

- **Rate limits:** the limiter is in-process, so limits apply per API replica.
  Use Redis-backed limits if the API scales out.
- **Live updates:** the frontend polls every 4 seconds, as the MVP spec
  recommends. There are no WebSockets.
- **Retry policy:** fixed globally for now. Per-endpoint policies are a P2 item.
