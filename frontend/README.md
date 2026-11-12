# Heimdall frontend

The dashboard for Heimdall: register endpoints, watch deliveries, inspect
every attempt, and replay events. React 19, TypeScript, Vite, Tailwind v4,
shadcn-style components on Radix, TanStack Query, React Router, React Hook
Form + Zod, Recharts and CodeMirror.

## Quick start

```bash
npm install
npm run dev:mock   # full UI against an in-browser mock API, no backend needed
npm run dev        # against the FastAPI backend on http://localhost:8000
```

With the mock API, sign in as `demo@heimdall.dev` / `DemoPassword123`, or
register a new account to see the empty states. The sidebar labels mock data
as such, so it can't be mistaken for live processing.

| Script | What it does |
| --- | --- |
| `npm run dev` | Vite dev server; `/api` is proxied to `VITE_DEV_API_PROXY` (default `http://localhost:8000`) |
| `npm run dev:mock` | Dev server with the MSW mock API |
| `npm run build` | Type-check and production build |
| `npm run typecheck` / `npm run lint` | `tsc -b` / ESLint |
| `npm test` | Vitest + React Testing Library |
| `npm run test:e2e` | Playwright at desktop, tablet and 375px mobile sizes, against the mock API |
| `npm run test:e2e:stack` | The spec's three end-to-end scenarios (§11.5) against the running docker compose stack: `make up && make e2e-stack` |

Playwright needs its browser once: `npx playwright install chromium`. To run
the same E2E specs against a deployed stack, set `PLAYWRIGHT_BASE_URL`.

## Production

In production the API serves the built app from the same origin. The root
`Dockerfile` builds both into one image (`make image`), so there is no separate
web server and `VITE_API_URL` stays empty. The `Dockerfile` and nginx template
in this folder remain for the development compose stack, or for hosting the app
separately behind a CDN.

## Environment

| Variable | Default | Purpose |
| --- | --- | --- |
| `VITE_API_URL` | empty (same origin) | Base URL of the API. Requests go to `${VITE_API_URL}/api/v1/...` with `credentials: 'include'` |
| `VITE_API_MOCKING` | `false` | Serve the MSW mock API in the browser (dev only; excluded from production builds) |

## Design

The interface is dark-first, as the spec asks, with an optional light theme
and a "match system" preference.

- **The delivery wire.** The overview opens with a live timeline. Each recent
  delivery is a tick: successes rise above the line and failures drop below
  it. Tick length is response time. On the event page, the **attempt trace**
  draws each execution the same way. Nodes are attempts, the gaps between
  them are the backoff the worker waited, and a scheduled retry is a dashed
  segment with a live countdown.
- **Type.** Instrument Sans (with its width axis condensed for headings), plus
  Martian Mono, condensed, for IDs, URLs, status codes and payloads.
- **Colour.** Violet primary on a cool ink background, with emerald, amber and
  red reserved for status. Status always comes with a label, and in charts
  failures also sit below the baseline, so red and green never carry meaning
  alone. Chart colours were checked with a colour-vision-deficiency validator.
- **Tokens.** Every colour is a CSS variable in `src/styles/globals.css`,
  mapped into Tailwind with `@theme inline`. Components never use raw hex.

## Structure

```
src/
  components/
    ui/          Button, Dialog, Select, Switch, Tooltip… (Radix-based primitives)
    layout/      app-sidebar, app-header, app-layout, logo
    common/      status pills, JSON viewer, copy buttons, empty/error states
    dashboard/   delivery wire, stat readout, charts
    endpoints/   endpoint form + action dialogs, signature snippet
    events/      events table, attempt trace, execution block
    deliveries/  attempt detail (response headers/body, failure explanation)
  pages/         one folder per route group (auth, dashboard, endpoints, events, analytics, settings)
  hooks/         TanStack Query hooks; live polling lives here
  services/      typed API calls, one per resource
  lib/           api-client (auth + refresh), query client, formatters
  contexts/      auth and theme providers
  schemas/       Zod form schemas
  routes/        route table and auth guards
  mocks/         MSW handlers and the in-memory mock database (dev/test only)
tests/
  components/ pages/   Vitest + RTL, using the same MSW handlers
  e2e/                 Playwright
```

## Auth model

The access token is kept **in memory only**. The refresh token is an HttpOnly
cookie set by the API. On load the app calls `POST /auth/refresh` to restore
the session. Any `401` triggers one deduplicated refresh and retries the
request; if the refresh fails, the app returns to the login page. Nothing
sensitive is written to `localStorage` (plan §3.2).

## Live updates

Following plan §3.8, the app polls rather than using WebSockets. The event
list, dashboard activity, and any event or delivery that is still `queued`,
`delivering` or `retrying` refresh every 4 seconds. Polling stops once a
delivery settles.

## API assumptions

The frontend follows the contract in `plan/PLAN.md`. Where the spec left
details open, it assumes the following (all types are in `src/types/api.ts`):

| Route | Assumption |
| --- | --- |
| `POST /auth/refresh` | Returns `{ access_token, token_type }` and rotates the cookie |
| `POST /auth/change-password` | `{ current_password, new_password }` → `204`; `400` if the current password is wrong. Not in the spec's route list |
| `GET /dashboard/stats?range=24h\|7d\|30d` | Totals plus a `series` of `{ bucket, total, delivered, failed, avg_ms, p95_ms }` used by the charts |
| `GET /dashboard/activity?limit=` | `{ items: ActivityItem[] }`, each with the latest delivery's status, HTTP code and duration |
| `GET /analytics/overview?range=` | Aggregates for the analytics page: series, p95, failure distribution, top endpoints, top failing event types. Not in the spec's route list |
| `GET /endpoints` | Each endpoint includes `stats: { total_events, success_rate, last_event_at }` |
| `GET /events` | Accepts the spec's filters plus `sort=created_at\|-created_at`; summaries include `endpoint_name` and `attempts` |
| `GET /events/{id}` | Adds `endpoint_url`, `endpoint_enabled` and `latest_delivery` |
| `GET /deliveries/{id}` | Adds `event_type`, `endpoint_id`, `endpoint_name`, `endpoint_url`; deliveries carry `max_attempts`, `last_http_status`, `last_duration_ms` |
| Statuses | Events and deliveries use `queued \| delivering \| retrying \| delivered \| failed` |
| Errors | The spec's `{ error: { code, message, details } }` shape. Plain FastAPI `detail` errors are handled too |

`src/mocks/handlers.ts` implements exactly this contract, so it doubles as an
executable reference for the backend.
