/**
 * In-memory mock of the Heimdall API's data. Dev/test only — enabled with
 * VITE_API_MOCKING=true. Deliveries progress in real time on read, so polling,
 * retries and countdowns behave the way they do against the real backend.
 */
import type {
  ApiKey,
  Delivery,
  DeliveryAttempt,
  DeliveryStatus,
  Endpoint,
  EventStatus,
} from '@/types/api'

/* ---------- deterministic randomness ---------- */

function mulberry32(seed: number) {
  return () => {
    seed |= 0
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

let rand = mulberry32(42)
const pick = <T,>(arr: readonly T[]) => arr[Math.floor(rand() * arr.length)]
const between = (a: number, b: number) => a + rand() * (b - a)

export function uuid() {
  const h = () => Math.floor(rand() * 0x10000).toString(16).padStart(4, '0')
  return `${h()}${h()}-${h()}-4${h().slice(1)}-${((8 + Math.floor(rand() * 4)).toString(16))}${h().slice(1)}-${h()}${h()}${h()}`
}

/* ---------- records ---------- */

export interface UserRec {
  id: string
  email: string
  password: string
  created_at: string
}
export interface EndpointRec extends Omit<Endpoint, 'stats'> {
  user_id: string
  signing_secret: string
  profile: Profile
}
export interface EventRec {
  source: 'live' | 'demo_fixture'
  id: string
  endpoint_id: string
  event_type: string
  payload: unknown
  payload_size: number
  idempotency_key: string | null
  created_at: string
}
export interface DeliveryRec extends Omit<Delivery, 'last_http_status' | 'last_duration_ms'> {
  /** outcomes for future attempts are decided when the attempt runs */
  profile: Profile
}
export interface ApiKeyRec extends ApiKey {
  user_id: string
}

export const MAX_ATTEMPTS = 5
const BACKOFF_MS = [0, 30_000, 120_000, 480_000, 1_800_000]

/** Delivery behaviour of a destination. */
export interface Profile {
  ok: number // success probability per attempt
  failures: ('500' | '502' | '503' | '429' | '404' | '400' | 'timeout' | 'connection')[]
  latency: [number, number]
}

const PROFILES: Record<string, Profile> = {
  solid: { ok: 0.985, failures: ['500', '502', 'timeout'], latency: [60, 260] },
  billing: { ok: 0.94, failures: ['503', '500', '429', '400'], latency: [120, 520] },
  flaky: { ok: 0.6, failures: ['500', '502', '503', 'timeout', 'connection', '400', '404'], latency: [300, 2400] },
  relay: { ok: 0.9, failures: ['429', '429', '500'], latency: [40, 180] },
  legacy: { ok: 0.7, failures: ['404', '400', '500'], latency: [400, 1400] },
  test: { ok: 0.85, failures: ['500', 'timeout'], latency: [80, 400] },
}

export const db = {
  users: [] as UserRec[],
  endpoints: [] as EndpointRec[],
  events: [] as EventRec[],
  deliveries: [] as DeliveryRec[],
  attempts: [] as DeliveryAttempt[],
  apiKeys: [] as ApiKeyRec[],
  revokedTokens: new Set<string>(),
}

export const DEMO = { email: 'demo@heimdall.dev', password: 'DemoPassword123' }

/* ---------- payloads ---------- */


function payloadFor(type: string, id: string, created: string) {
  const n = Math.floor(between(1000, 9999))
  const amount = Math.round(between(9, 480) * 100) / 100
  const base = { id, type, created_at: created }
  switch (type) {
    case 'order.created':
    case 'order.paid':
    case 'order.refunded':
      return {
        ...base,
        data: {
          order_id: `ORD-${n}`,
          amount,
          currency: pick(['USD', 'EUR', 'GBP']),
          customer: { id: `cus_${n}x`, email: `buyer${n}@example.com` },
          items: Array.from({ length: Math.ceil(between(1, 4)) }, (_, i) => ({
            sku: `SKU-${n + i}`,
            quantity: Math.ceil(between(1, 3)),
            unit_price: Math.round(between(5, 120) * 100) / 100,
          })),
          refunded: type === 'order.refunded',
        },
      }
    case 'invoice.paid':
    case 'invoice.payment_failed':
      return {
        ...base,
        data: {
          invoice_id: `INV-2026-${n}`,
          amount_due: amount,
          currency: 'USD',
          attempt_count: type === 'invoice.payment_failed' ? Math.ceil(between(1, 3)) : 1,
          next_payment_attempt: type === 'invoice.payment_failed' ? created : null,
        },
      }
    case 'customer.created':
      return { ...base, data: { customer_id: `cus_${n}x`, email: `new${n}@example.com`, plan: pick(['free', 'pro', 'team']), metadata: {} } }
    case 'subscription.updated':
      return {
        ...base,
        data: {
          subscription_id: `sub_${n}q`,
          status: pick(['active', 'past_due', 'active']),
          plan: { id: pick(['pro_monthly', 'team_annual']), amount, interval: pick(['month', 'year']) },
          cancel_at_period_end: rand() < 0.15,
        },
      }
    default:
      return {
        ...base,
        data: { shipment_id: `SHP-${n}`, carrier: pick(['UPS', 'DHL', 'FedEx']), tracking_number: `1Z${n}${n}`, eta_days: Math.ceil(between(1, 6)) },
      }
  }
}

/* ---------- attempts ---------- */

interface FakeResponse {
  http_status: number | null
  error_message: string | null
  body: string | null
  headers: Record<string, string> | null
}

function failureResponse(kind: Profile['failures'][number]): FakeResponse {
  switch (kind) {
    case 'timeout':
      return { http_status: null, error_message: 'Request timed out after 10s', body: null, headers: null }
    case 'connection':
      return { http_status: null, error_message: 'Connection refused', body: null, headers: null }
    case '429':
      return {
        http_status: 429,
        error_message: null,
        body: JSON.stringify({ error: 'rate_limited', retry_after: 30 }),
        headers: { 'content-type': 'application/json', 'retry-after': '30' },
      }
    case '404':
      return { http_status: 404, error_message: null, body: '<html><body><h1>404 Not Found</h1></body></html>', headers: { 'content-type': 'text/html' } }
    case '400':
      return {
        http_status: 400,
        error_message: null,
        body: JSON.stringify({ error: 'invalid_payload', message: 'Missing field customer.id' }),
        headers: { 'content-type': 'application/json' },
      }
    default:
      return {
        http_status: Number(kind),
        error_message: null,
        body: kind === '502' ? '<html><body>502 Bad Gateway</body></html>' : JSON.stringify({ error: 'internal_error', request_id: `req_${uuid().slice(0, 12)}` }),
        headers: { 'content-type': kind === '502' ? 'text/html' : 'application/json', server: 'nginx' },
      }
  }
}

const retryable = (s: number | null) => s == null || s === 408 || s === 425 || s === 429 || s >= 500

function runAttempt(d: DeliveryRec, at: number) {
  const p = d.profile
  const ok = rand() < p.ok
  const duration = Math.round(between(p.latency[0], p.latency[1]))
  const n = d.current_attempt + 1
  let res: FakeResponse
  if (ok) {
    res = {
      http_status: rand() < 0.9 ? 200 : 204,
      error_message: null,
      body: rand() < 0.6 ? JSON.stringify({ received: true }) : '',
      headers: { 'content-type': 'application/json', 'x-request-id': `rq_${uuid().slice(0, 10)}` },
    }
  } else {
    res = failureResponse(pick(p.failures))
  }
  const attempt: DeliveryAttempt = {
    id: uuid(),
    delivery_id: d.id,
    attempt_number: n,
    http_status: res.http_status,
    response_body: res.body,
    response_headers: res.headers,
    duration_ms: res.error_message?.includes('timed out') ? 10_000 : duration,
    error_message: res.error_message,
    attempted_at: new Date(at).toISOString(),
  }
  db.attempts.push(attempt)
  d.current_attempt = n
  d.started_at ??= attempt.attempted_at
  const completedAt = new Date(at + (attempt.duration_ms ?? 0)).toISOString()

  if (ok) {
    d.status = 'delivered'
    d.next_attempt_at = null
    d.completed_at = completedAt
  } else if (!retryable(res.http_status) || n >= MAX_ATTEMPTS) {
    d.status = 'failed'
    d.next_attempt_at = null
    d.completed_at = completedAt
  } else {
    d.status = 'retrying'
    d.next_attempt_at = new Date(at + BACKOFF_MS[n] + between(0, 2000)).toISOString()
  }
}

/** Process every attempt whose scheduled time has passed. */
export function advance(d: DeliveryRec, now = Date.now()) {
  // first attempt runs ~1.5s after queueing, so "Delivering" is visible
  if (d.status === 'queued' && d.current_attempt === 0) {
    const created = new Date(d.created_at).getTime()
    if (now - created > 600) d.status = 'delivering'
    if (now - created > 1800) runAttempt(d, created + 1800)
  }
  while (d.status === 'retrying' && d.next_attempt_at && new Date(d.next_attempt_at).getTime() <= now) {
    runAttempt(d, new Date(d.next_attempt_at).getTime())
  }
}

export function createDelivery(event: EventRec, trigger: 'automatic' | 'manual', profile: Profile, createdAt: string) {
  const prior = db.deliveries.filter((d) => d.event_id === event.id).length
  const d: DeliveryRec = {
    id: uuid(),
    event_id: event.id,
    execution_number: prior + 1,
    trigger_type: trigger,
    status: 'queued',
    current_attempt: 0,
    max_attempts: MAX_ATTEMPTS,
    next_attempt_at: null,
    started_at: null,
    completed_at: null,
    created_at: createdAt,
    profile,
  }
  db.deliveries.push(d)
  return d
}

export function createEvent(endpoint: EndpointRec, type: string, createdAt: string, idempotencyKey: string | null = null) {
  const id = uuid()
  const payload = payloadFor(type, id, createdAt)
  const ev: EventRec = {
    source: 'live',
    id,
    endpoint_id: endpoint.id,
    event_type: type,
    payload,
    payload_size: JSON.stringify(payload).length,
    idempotency_key: idempotencyKey,
    created_at: createdAt,
  }
  db.events.push(ev)
  return ev
}

export function profileFor(name: keyof typeof PROFILES) {
  return PROFILES[name]
}

/* ---------- derived ---------- */

export function deliveriesFor(eventId: string) {
  return db.deliveries.filter((d) => d.event_id === eventId)
}

export function latestDelivery(eventId: string) {
  let latest: DeliveryRec | undefined
  for (const d of db.deliveries) {
    if (d.event_id === eventId && (!latest || d.execution_number > latest.execution_number)) latest = d
  }
  return latest
}

export function attemptsFor(deliveryId: string) {
  return db.attempts.filter((a) => a.delivery_id === deliveryId).sort((a, b) => a.attempt_number - b.attempt_number)
}

export function eventStatus(eventId: string): EventStatus {
  const d = latestDelivery(eventId)
  if (!d) return 'queued'
  advance(d)
  return d.status as DeliveryStatus
}

/* ---------- seed ---------- */

export function seed() {
  rand = mulberry32(42)
  db.users = []
  db.endpoints = []
  db.events = []
  db.deliveries = []
  db.attempts = []
  db.apiKeys = []
  db.revokedTokens.clear()

  const now = Date.now()
  const user: UserRec = {
    id: uuid(),
    email: DEMO.email,
    password: DEMO.password,
    created_at: new Date(now - 41 * 86_400_000).toISOString(),
  }
  db.users.push(user)

  const defs = [
    { name: 'Production orders', url: 'https://api.northwind-shop.com/webhooks/orders', description: 'Order lifecycle events for the storefront', profile: 'solid', weight: 5, types: ['order.created', 'order.paid', 'order.refunded'] },
    { name: 'Billing service', url: 'https://billing.northwind-shop.com/hooks/heimdall', description: 'Invoices and subscription changes', profile: 'billing', weight: 3, types: ['invoice.paid', 'invoice.payment_failed', 'subscription.updated'] },
    { name: 'Fulfilment (staging)', url: 'https://staging.fulfil.northwind-shop.com/api/webhooks', description: 'Unstable staging receiver', profile: 'flaky', weight: 2, types: ['shipment.dispatched', 'order.paid'] },
    { name: 'Slack relay', url: 'https://relay.northwind-ops.io/wh/9f2c41', description: null, profile: 'relay', weight: 2, types: ['customer.created', 'order.refunded', 'invoice.payment_failed'] },
    { name: 'Legacy CRM', url: 'https://crm-old.northwind-shop.com/inbound/hook.php', description: 'Being retired in Q1', profile: 'legacy', weight: 1, types: ['customer.created'], disabled: true },
  ] as const

  const endpoints = defs.map((def, i) => {
    const created = new Date(now - (40 - i * 3) * 86_400_000).toISOString()
    const rec: EndpointRec = {
      id: uuid(),
      user_id: user.id,
      name: def.name,
      url: def.url,
      description: def.description,
      enabled: !('disabled' in def && def.disabled),
      created_at: created,
      updated_at: created,
      signing_secret: `whsec_${uuid().replace(/-/g, '')}`,
      profile: PROFILES[def.profile],
    }
    db.endpoints.push(rec)
    return { rec, def }
  })

  const totalWeight = defs.reduce((s, d) => s + d.weight, 0)
  const pickEndpoint = () => {
    let r = rand() * totalWeight
    for (const e of endpoints) {
      r -= e.def.weight
      if (r <= 0) return e
    }
    return endpoints[0]
  }

  // Event times: sparse across 30 days, denser across the last day, a burst in the last hour.
  const times: number[] = []
  for (let i = 0; i < 520; i++) times.push(now - between(1, 30) * 86_400_000)
  for (let i = 0; i < 260; i++) times.push(now - between(0.05, 24) * 3_600_000)
  for (let i = 0; i < 46; i++) times.push(now - between(0.2, 58) * 60_000)
  times.sort((a, b) => a - b)

  for (const t of times) {
    let { rec, def } = pickEndpoint()
    // the disabled endpoint stopped receiving a week ago
    if (!rec.enabled && t > now - 7 * 86_400_000) ({ rec, def } = endpoints[0])
    const created = new Date(t).toISOString()
    const ev = createEvent(rec, pick(def.types as readonly string[]), created, rand() < 0.5 ? `idem-${Math.floor(t / 1000)}` : null)
    const d = createDelivery(ev, 'automatic', rec.profile, created)
    advance(d, Math.min(now, t + 2000))
    advance(d, now)
  }

  // a few manual replays of failed events
  const failed = db.deliveries.filter((d) => d.status === 'failed').slice(-6, -2)
  for (const f of failed) {
    const ev = db.events.find((e) => e.id === f.event_id)!
    const at = new Date(new Date(f.completed_at!).getTime() + 3_600_000)
    if (at.getTime() > now) continue
    const d = createDelivery(ev, 'manual', { ...profileFor('solid'), ok: 1 }, at.toISOString())
    advance(d, now)
  }

  // everything above is sample history, labelled like the real seed script's fixtures
  for (const e of db.events) e.source = 'demo_fixture'

  // pin one recent event mid-retry so the countdown is always demonstrable
  const flaky = endpoints[2].rec
  const ev = createEvent(flaky, 'shipment.dispatched', new Date(now - 50_000).toISOString(), 'ship-demo-retry')
  const d = createDelivery(ev, 'automatic', { ...flaky.profile, ok: 0, failures: ['503'] }, ev.created_at)
  runAttempt(d, now - 48_000)
  d.next_attempt_at = new Date(now + 45_000).toISOString()
  d.status = 'retrying'
  d.profile = { ...flaky.profile, ok: 1 }

  db.apiKeys.push(
    {
      id: uuid(),
      user_id: user.id,
      name: 'Production backend',
      key_prefix: 'wh_live_8fK2',
      last_used_at: new Date(now - 40_000).toISOString(),
      revoked_at: null,
      created_at: new Date(now - 38 * 86_400_000).toISOString(),
    },
    {
      id: uuid(),
      user_id: user.id,
      name: 'Staging',
      key_prefix: 'wh_live_Qa71',
      last_used_at: new Date(now - 3 * 86_400_000).toISOString(),
      revoked_at: null,
      created_at: new Date(now - 20 * 86_400_000).toISOString(),
    },
    {
      id: uuid(),
      user_id: user.id,
      name: 'Old laptop script',
      key_prefix: 'wh_live_zz03',
      last_used_at: new Date(now - 29 * 86_400_000).toISOString(),
      revoked_at: new Date(now - 25 * 86_400_000).toISOString(),
      created_at: new Date(now - 36 * 86_400_000).toISOString(),
    },
  )
}

/** Fresh random generator for runtime records (keeps the seed deterministic). */
export function reseedRuntime() {
  rand = mulberry32(Date.now() & 0xffffffff)
}
