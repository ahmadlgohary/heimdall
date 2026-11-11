import { delay, http, HttpResponse } from 'msw'
import type {
  AnalyticsOverview,
  DashboardStats,
  Delivery,
  DeliveryDetail,
  Endpoint,
  EventDetail,
  EventSummary,
  FailureReason,
  SeriesPoint,
  TimeRange,
} from '@/types/api'
import {
  advance,
  attemptsFor,
  createDelivery,
  createEvent,
  db,
  DEMO,
  deliveriesFor,
  eventStatus,
  latestDelivery,
  profileFor,
  reseedRuntime,
  seed,
  uuid,
  type DeliveryRec,
  type EndpointRec,
  type EventRec,
} from './db'

const BASE = '*/api/v1'
const SESSION_KEY = 'heimdall.mock.session'

export const mockConfig = { latency: true }

/* ---------- session (stands in for the HttpOnly refresh cookie) ---------- */

const memorySession: { userId: string | null } = { userId: null }
function getSession() {
  try {
    return localStorage.getItem(SESSION_KEY)
  } catch {
    return memorySession.userId
  }
}
function setSession(userId: string | null) {
  memorySession.userId = userId
  try {
    if (userId) localStorage.setItem(SESSION_KEY, userId)
    else localStorage.removeItem(SESSION_KEY)
  } catch {
    /* ignore */
  }
}

const tokenFor = (userId: string) => `mock.${userId}.${Date.now().toString(36)}`

function authUser(request: Request) {
  const header = request.headers.get('authorization') ?? ''
  const token = header.replace(/^Bearer /, '')
  if (!token.startsWith('mock.') || db.revokedTokens.has(token)) return null
  const userId = token.split('.')[1]
  return db.users.find((u) => u.id === userId) ?? null
}

/* ---------- helpers ---------- */

function error(status: number, code: string, message: string, details: unknown = null) {
  return HttpResponse.json({ error: { code, message, details } }, { status })
}

async function latency() {
  if (mockConfig.latency) await delay(Math.round(120 + Math.random() * 260))
}

function paginate<T>(items: T[], url: URL) {
  const page = Math.max(Number(url.searchParams.get('page') ?? 1) || 1, 1)
  const limit = Math.min(Math.max(Number(url.searchParams.get('limit') ?? 20) || 20, 1), 100)
  const total = items.length
  return {
    items: items.slice((page - 1) * limit, page * limit),
    pagination: { page, limit, total, total_pages: Math.ceil(total / limit) },
  }
}

const ownedEndpoints = (userId: string) => db.endpoints.filter((e) => e.user_id === userId)
const ownedEndpointIds = (userId: string) => new Set(ownedEndpoints(userId).map((e) => e.id))

function ownedEvent(userId: string, id: string) {
  const ev = db.events.find((e) => e.id === id)
  if (!ev || !ownedEndpointIds(userId).has(ev.endpoint_id)) return null
  return ev
}

function toDelivery(d: DeliveryRec): Delivery {
  advance(d)
  const attempts = attemptsFor(d.id)
  const last = attempts[attempts.length - 1]
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { profile, ...rest } = d
  return { ...rest, last_http_status: last?.http_status ?? null, last_duration_ms: last?.duration_ms ?? null }
}

function toSummary(ev: EventRec): EventSummary {
  const ep = db.endpoints.find((e) => e.id === ev.endpoint_id)!
  const status = eventStatus(ev.id)
  const attempts = deliveriesFor(ev.id).reduce((s, d) => s + d.current_attempt, 0)
  return {
    id: ev.id,
    event_type: ev.event_type,
    endpoint_id: ev.endpoint_id,
    endpoint_name: ep.name,
    status,
    attempts,
    payload_size: ev.payload_size,
    idempotency_key: ev.idempotency_key,
    created_at: ev.created_at,
    source: ev.source,
  }
}

function endpointStats(ep: EndpointRec) {
  const events = db.events.filter((e) => e.endpoint_id === ep.id)
  let ok = 0
  let done = 0
  let last: string | null = null
  for (const ev of events) {
    const s = eventStatus(ev.id)
    if (s === 'delivered') ok++
    if (s === 'delivered' || s === 'failed') done++
    if (!last || ev.created_at > last) last = ev.created_at
  }
  return { total_events: events.length, success_rate: done ? ok / done : null, last_event_at: last }
}

function toEndpoint(ep: EndpointRec, withStats = true): Endpoint {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { user_id, signing_secret, profile, ...rest } = ep
  return withStats ? { ...rest, stats: endpointStats(ep) } : rest
}

const newSecret = () => `whsec_${uuid().replace(/-/g, '')}${uuid().replace(/-/g, '').slice(0, 8)}`

const PRIVATE = /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|0\.0\.0\.0)/
function validateUrl(url: string) {
  try {
    const u = new URL(url)
    if (u.protocol !== 'https:') return 'Destination URLs must use HTTPS.'
    if (PRIVATE.test(u.hostname)) return 'Private and local network addresses can’t receive webhooks.'
    return null
  } catch {
    return 'Enter a valid URL.'
  }
}

/* ---------- aggregates ---------- */

const RANGE_MS: Record<TimeRange, number> = { '24h': 86_400_000, '7d': 7 * 86_400_000, '30d': 30 * 86_400_000 }
const BUCKET_MS: Record<TimeRange, number> = { '24h': 3_600_000, '7d': 12 * 3_600_000, '30d': 86_400_000 }

function p95(values: number[]) {
  if (!values.length) return null
  const s = [...values].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.floor(s.length * 0.95))]
}

function aggregate(userId: string, range: TimeRange) {
  const now = Date.now()
  const bucketMs = BUCKET_MS[range]
  const end = Math.ceil(now / bucketMs) * bucketMs
  const start = end - RANGE_MS[range]
  const ids = ownedEndpointIds(userId)
  const events = db.events.filter((e) => ids.has(e.endpoint_id) && new Date(e.created_at).getTime() >= start)
  const n = Math.round(RANGE_MS[range] / bucketMs)
  const buckets = Array.from({ length: n }, (_, i) => ({
    bucket: new Date(start + i * bucketMs).toISOString(),
    total: 0,
    delivered: 0,
    failed: 0,
    durations: [] as number[],
  }))

  let delivered = 0
  let failed = 0
  const durations: number[] = []
  const failures: Record<FailureReason, number> = { http_5xx: 0, http_4xx: 0, http_3xx: 0, http_429: 0, timeout: 0, connection: 0 }
  const perEndpoint = new Map<string, { total: number; ok: number; done: number }>()
  const failedTypes = new Map<string, number>()

  for (const ev of events) {
    const i = Math.min(Math.floor((new Date(ev.created_at).getTime() - start) / bucketMs), n - 1)
    const b = buckets[i]
    const status = eventStatus(ev.id)
    b.total++
    const pe = perEndpoint.get(ev.endpoint_id) ?? { total: 0, ok: 0, done: 0 }
    pe.total++
    if (status === 'delivered') {
      b.delivered++
      delivered++
      pe.ok++
      pe.done++
    } else if (status === 'failed') {
      b.failed++
      failed++
      pe.done++
      failedTypes.set(ev.event_type, (failedTypes.get(ev.event_type) ?? 0) + 1)
    }
    perEndpoint.set(ev.endpoint_id, pe)

    for (const d of deliveriesFor(ev.id)) {
      for (const a of attemptsFor(d.id)) {
        if (a.duration_ms != null && a.http_status != null) {
          b.durations.push(a.duration_ms)
          durations.push(a.duration_ms)
        }
        const s = a.http_status
        if (s != null && s >= 200 && s < 300) continue
        if (s == null) failures[a.error_message?.includes('timed out') ? 'timeout' : 'connection']++
        else if (s === 429) failures.http_429++
        else if (s >= 500) failures.http_5xx++
        else failures.http_4xx++
      }
    }
  }

  const series: SeriesPoint[] = buckets.map((b) => ({
    bucket: b.bucket,
    total: b.total,
    delivered: b.delivered,
    failed: b.failed,
    avg_ms: b.durations.length ? Math.round(b.durations.reduce((s, v) => s + v, 0) / b.durations.length) : null,
    p95_ms: p95(b.durations),
  }))

  const avg = durations.length ? Math.round(durations.reduce((s, v) => s + v, 0) / durations.length) : null
  return {
    events,
    delivered,
    failed,
    successRate: delivered + failed ? delivered / (delivered + failed) : null,
    avg,
    p95: p95(durations),
    series,
    failures,
    perEndpoint,
    failedTypes,
  }
}

/* ---------- handlers ---------- */

type Ctx = { request: Request; params: Record<string, string | readonly string[] | undefined> }

/** Wrap a handler that needs an authenticated user. */
function authed(fn: (ctx: Ctx & { userId: string; url: URL }) => Response | Promise<Response>) {
  return async (ctx: Ctx) => {
    ensureSeeded()
    await latency()
    const user = authUser(ctx.request)
    if (!user) return error(401, 'UNAUTHORIZED', 'Authentication required.')
    return fn({ ...ctx, userId: user.id, url: new URL(ctx.request.url) })
  }
}

const param = (ctx: Ctx, key: string) => String(ctx.params[key])

/** Like authed(), for routes that change data: the demo account is read-only. */
function writable(fn: Parameters<typeof authed>[0]) {
  return authed((ctx) => {
    const user = db.users.find((u) => u.id === ctx.userId)
    if (user?.email === DEMO.email)
      return error(403, 'DEMO_READ_ONLY', 'The demo account is read-only. Create your own account to make changes.')
    return fn(ctx)
  })
}

let seeded = false
export function ensureSeeded() {
  if (seeded) return
  seed()
  reseedRuntime()
  seeded = true
}

export function resetMockDb() {
  seeded = false
  setSession(null)
  ensureSeeded()
}

export const handlers = [
  /* auth */
  http.post(`${BASE}/auth/register`, async ({ request }) => {
    ensureSeeded()
    await latency()
    const { email, password } = (await request.json()) as { email: string; password: string }
    if (!email || !/^\S+@\S+\.\S+$/.test(email)) return error(422, 'VALIDATION_ERROR', 'Enter a valid email address.')
    if (!password || password.length < 12) return error(422, 'VALIDATION_ERROR', 'Password must be at least 12 characters.')
    if (email.toLowerCase() === DEMO.email || db.users.some((u) => u.email.toLowerCase() === email.toLowerCase()))
      return error(409, 'EMAIL_TAKEN', 'An account with this email already exists.')
    const user = { id: uuid(), email, password, created_at: new Date().toISOString() }
    db.users.push(user)
    setSession(user.id)
    return HttpResponse.json(
      { user: { id: user.id, email, created_at: user.created_at, is_demo: false }, access_token: tokenFor(user.id), token_type: 'bearer' },
      { status: 201 },
    )
  }),

  http.post(`${BASE}/auth/login`, async ({ request }) => {
    ensureSeeded()
    await latency()
    const { email, password } = (await request.json()) as { email: string; password: string }
    const user = db.users.find((u) => u.email.toLowerCase() === email?.toLowerCase())
    if (!user || user.password !== password) return error(401, 'INVALID_CREDENTIALS', 'Incorrect email or password.')
    setSession(user.id)
    return HttpResponse.json({
      user: { id: user.id, email: user.email, created_at: user.created_at, is_demo: user.email === DEMO.email },
      access_token: tokenFor(user.id),
      token_type: 'bearer',
    })
  }),

  http.post(`${BASE}/auth/refresh`, async () => {
    ensureSeeded()
    await latency()
    const userId = getSession()
    const user = db.users.find((u) => u.id === userId)
    if (!user) return error(401, 'REFRESH_INVALID', 'Session expired.')
    return HttpResponse.json({ access_token: tokenFor(user.id), token_type: 'bearer' })
  }),

  http.post(`${BASE}/auth/logout`, async ({ request }) => {
    const token = request.headers.get('authorization')?.replace(/^Bearer /, '')
    if (token) db.revokedTokens.add(token)
    setSession(null)
    return new HttpResponse(null, { status: 204 })
  }),

  http.get(`${BASE}/auth/me`, authed(({ userId }) => {
    const u = db.users.find((x) => x.id === userId)!
    return HttpResponse.json({ id: u.id, email: u.email, created_at: u.created_at, is_demo: u.email === DEMO.email })
  })),

  http.post(`${BASE}/auth/change-password`, writable(async ({ request, userId }) => {
    const body = (await request.json()) as { current_password: string; new_password: string }
    const u = db.users.find((x) => x.id === userId)!
    if (u.password !== body.current_password) return error(400, 'INVALID_PASSWORD', 'Current password is incorrect.')
    u.password = body.new_password
    return new HttpResponse(null, { status: 204 })
  })),

  http.get(`${BASE}/demo`, async () => {
    await latency()
    return HttpResponse.json({ enabled: true, email: DEMO.email, password: DEMO.password })
  }),

  /* dashboard & analytics */
  http.get(`${BASE}/dashboard/stats`, authed(({ url, userId }) => {
    const range = (url.searchParams.get('range') ?? '24h') as TimeRange
    const a = aggregate(userId, range)
    const body: DashboardStats = {
      range,
      total_events: a.events.length,
      successful_deliveries: a.delivered,
      failed_deliveries: a.failed,
      success_rate: a.successRate,
      avg_response_ms: a.avg,
      series: a.series,
    }
    return HttpResponse.json(body)
  })),

  http.get(`${BASE}/dashboard/activity`, authed(({ url, userId }) => {
    const limit = Math.min(Number(url.searchParams.get('limit') ?? 20), 100)
    const ids = ownedEndpointIds(userId)
    const events = db.events
      .filter((e) => ids.has(e.endpoint_id))
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .slice(0, limit)
    const items = events.map((ev) => {
      const d = latestDelivery(ev.id)
      if (d) advance(d)
      const last = d ? attemptsFor(d.id).at(-1) : undefined
      return {
        event_id: ev.id,
        delivery_id: d?.id ?? null,
        event_type: ev.event_type,
        endpoint_id: ev.endpoint_id,
        endpoint_name: db.endpoints.find((e) => e.id === ev.endpoint_id)!.name,
        status: d?.status ?? 'queued',
        http_status: last?.http_status ?? null,
        duration_ms: last?.duration_ms ?? null,
        created_at: ev.created_at,
        source: ev.source,
      }
    })
    return HttpResponse.json({ items })
  })),

  http.get(`${BASE}/analytics/overview`, authed(({ url, userId }) => {
    const range = (url.searchParams.get('range') ?? '7d') as TimeRange
    const a = aggregate(userId, range)
    const body: AnalyticsOverview = {
      range,
      total_events: a.events.length,
      success_rate: a.successRate,
      avg_latency_ms: a.avg,
      p95_latency_ms: a.p95,
      series: a.series,
      failure_distribution: (Object.entries(a.failures) as [FailureReason, number][])
        .filter(([, c]) => c > 0)
        .map(([reason, count]) => ({ reason, count })),
      top_endpoints: [...a.perEndpoint.entries()]
        .map(([id, s]) => ({
          endpoint_id: id,
          name: db.endpoints.find((e) => e.id === id)!.name,
          total: s.total,
          success_rate: s.done ? s.ok / s.done : null,
        }))
        .sort((x, y) => y.total - x.total)
        .slice(0, 5),
      top_failed_event_types: [...a.failedTypes.entries()]
        .map(([event_type, count]) => ({ event_type, count }))
        .sort((x, y) => y.count - x.count)
        .slice(0, 5),
    }
    return HttpResponse.json(body)
  })),

  /* endpoints */
  http.get(`${BASE}/endpoints`, authed(({ url, userId }) => {
    const items = ownedEndpoints(userId)
      .sort((a, b) => a.created_at.localeCompare(b.created_at))
      .map((e) => toEndpoint(e))
    return HttpResponse.json(paginate(items, url))
  })),

  http.post(`${BASE}/endpoints`, writable(async ({ request, userId }) => {
    const body = (await request.json()) as { name: string; url: string; description?: string | null; enabled?: boolean }
    if (!body.name?.trim()) return error(422, 'VALIDATION_ERROR', 'Name is required.')
    const urlError = validateUrl(body.url)
    if (urlError) return error(422, 'INVALID_URL', urlError)
    const now = new Date().toISOString()
    const ep: EndpointRec = {
      id: uuid(),
      user_id: userId,
      name: body.name.trim(),
      url: body.url.trim(),
      description: body.description ?? null,
      enabled: body.enabled ?? true,
      created_at: now,
      updated_at: now,
      signing_secret: newSecret(),
      profile: profileFor('test'),
    }
    db.endpoints.push(ep)
    return HttpResponse.json({ ...toEndpoint(ep, false), signing_secret: ep.signing_secret }, { status: 201 })
  })),

  http.get(`${BASE}/endpoints/:id`, authed((ctx) => {
    const ep = ownedEndpoints(ctx.userId).find((e) => e.id === param(ctx, 'id'))
    if (!ep) return error(404, 'ENDPOINT_NOT_FOUND', 'The requested endpoint does not exist.')
    return HttpResponse.json(toEndpoint(ep))
  })),

  http.patch(`${BASE}/endpoints/:id`, writable(async (ctx) => {
    const ep = ownedEndpoints(ctx.userId).find((e) => e.id === param(ctx, 'id'))
    if (!ep) return error(404, 'ENDPOINT_NOT_FOUND', 'The requested endpoint does not exist.')
    const body = (await ctx.request.json()) as Partial<Endpoint>
    if (body.url !== undefined) {
      const urlError = validateUrl(body.url)
      if (urlError) return error(422, 'INVALID_URL', urlError)
    }
    Object.assign(ep, {
      ...(body.name !== undefined && { name: body.name }),
      ...(body.url !== undefined && { url: body.url }),
      ...(body.description !== undefined && { description: body.description }),
      ...(body.enabled !== undefined && { enabled: body.enabled }),
      updated_at: new Date().toISOString(),
    })
    return HttpResponse.json(toEndpoint(ep))
  })),

  http.delete(`${BASE}/endpoints/:id`, writable((ctx) => {
    const idx = db.endpoints.findIndex((e) => e.id === param(ctx, 'id') && e.user_id === ctx.userId)
    if (idx < 0) return error(404, 'ENDPOINT_NOT_FOUND', 'The requested endpoint does not exist.')
    const [ep] = db.endpoints.splice(idx, 1)
    const eventIds = new Set(db.events.filter((e) => e.endpoint_id === ep.id).map((e) => e.id))
    db.events = db.events.filter((e) => !eventIds.has(e.id))
    db.deliveries = db.deliveries.filter((d) => !eventIds.has(d.event_id))
    return new HttpResponse(null, { status: 204 })
  })),

  http.post(`${BASE}/endpoints/:id/rotate-secret`, writable((ctx) => {
    const ep = ownedEndpoints(ctx.userId).find((e) => e.id === param(ctx, 'id'))
    if (!ep) return error(404, 'ENDPOINT_NOT_FOUND', 'The requested endpoint does not exist.')
    ep.signing_secret = newSecret()
    ep.updated_at = new Date().toISOString()
    return HttpResponse.json({ signing_secret: ep.signing_secret })
  })),

  http.post(`${BASE}/endpoints/:id/test`, writable((ctx) => {
    const ep = ownedEndpoints(ctx.userId).find((e) => e.id === param(ctx, 'id'))
    if (!ep) return error(404, 'ENDPOINT_NOT_FOUND', 'The requested endpoint does not exist.')
    if (!ep.enabled) return error(409, 'ENDPOINT_DISABLED', 'Enable the endpoint before sending a test event.')
    const now = new Date().toISOString()
    const ev = createEvent(ep, 'heimdall.test', now)
    ev.payload = { id: ev.id, type: 'heimdall.test', created_at: now, data: { message: 'Test event from Heimdall', endpoint: ep.name } }
    ev.payload_size = JSON.stringify(ev.payload).length
    createDelivery(ev, 'automatic', ep.profile, now)
    return HttpResponse.json({ event_id: ev.id, status: 'queued', message: 'Event accepted for delivery' }, { status: 202 })
  })),

  /* events */
  http.get(`${BASE}/events`, authed(({ url, userId }) => {
    const sp = url.searchParams
    const ids = ownedEndpointIds(userId)
    const status = sp.get('status')
    const endpointId = sp.get('endpoint_id')
    const type = sp.get('event_type')
    const search = sp.get('search')?.toLowerCase().replace(/^evt_/, '')
    const from = sp.get('from') ? new Date(sp.get('from')!).getTime() : null
    const to = sp.get('to') ? new Date(sp.get('to')!).getTime() : null
    const asc = sp.get('sort') === 'created_at'

    let events = db.events.filter((e) => ids.has(e.endpoint_id))
    if (endpointId) events = events.filter((e) => e.endpoint_id === endpointId)
    if (type) events = events.filter((e) => e.event_type === type)
    if (from) events = events.filter((e) => new Date(e.created_at).getTime() >= from)
    if (to) events = events.filter((e) => new Date(e.created_at).getTime() <= to)
    if (search)
      events = events.filter(
        (e) => e.id.replace(/-/g, '').includes(search.replace(/-/g, '')) || e.event_type.toLowerCase().includes(search),
      )
    events.sort((a, b) => (asc ? a.created_at.localeCompare(b.created_at) : b.created_at.localeCompare(a.created_at)))
    let summaries = events.map(toSummary)
    if (status) summaries = summaries.filter((s) => s.status === status)
    return HttpResponse.json(paginate(summaries, url))
  })),

  http.get(`${BASE}/events/:id`, authed((ctx) => {
    const ev = ownedEvent(ctx.userId, param(ctx, 'id'))
    if (!ev) return error(404, 'EVENT_NOT_FOUND', 'The requested event does not exist.')
    const ep = db.endpoints.find((e) => e.id === ev.endpoint_id)!
    const latest = latestDelivery(ev.id)
    const body: EventDetail = {
      ...toSummary(ev),
      endpoint_url: ep.url,
      endpoint_enabled: ep.enabled,
      latest_delivery: latest ? toDelivery(latest) : null,
    }
    return HttpResponse.json(body)
  })),

  http.get(`${BASE}/events/:id/payload`, authed((ctx) => {
    const ev = ownedEvent(ctx.userId, param(ctx, 'id'))
    if (!ev) return error(404, 'EVENT_NOT_FOUND', 'The requested event does not exist.')
    return HttpResponse.json(ev.payload as Record<string, unknown>)
  })),

  http.get(`${BASE}/events/:id/deliveries`, authed((ctx) => {
    const ev = ownedEvent(ctx.userId, param(ctx, 'id'))
    if (!ev) return error(404, 'EVENT_NOT_FOUND', 'The requested event does not exist.')
    const items = deliveriesFor(ev.id)
      .sort((a, b) => b.execution_number - a.execution_number)
      .map(toDelivery)
    return HttpResponse.json(paginate(items, ctx.url))
  })),

  http.post(`${BASE}/events/:id/replay`, writable((ctx) => {
    const ev = ownedEvent(ctx.userId, param(ctx, 'id'))
    if (!ev) return error(404, 'EVENT_NOT_FOUND', 'The requested event does not exist.')
    const ep = db.endpoints.find((e) => e.id === ev.endpoint_id)!
    if (!ep.enabled) return error(409, 'ENDPOINT_DISABLED', 'Enable the endpoint before replaying events.')
    const d = createDelivery(ev, 'manual', ep.profile, new Date().toISOString())
    return HttpResponse.json(toDelivery(d), { status: 202 })
  })),

  /* deliveries */
  http.get(`${BASE}/deliveries/:id`, authed((ctx) => {
    const d = db.deliveries.find((x) => x.id === param(ctx, 'id'))
    const ev = d && ownedEvent(ctx.userId, d.event_id)
    if (!d || !ev) return error(404, 'DELIVERY_NOT_FOUND', 'The requested delivery does not exist.')
    const ep = db.endpoints.find((e) => e.id === ev.endpoint_id)!
    const body: DeliveryDetail = {
      ...toDelivery(d),
      event_type: ev.event_type,
      endpoint_id: ep.id,
      endpoint_name: ep.name,
      endpoint_url: ep.url,
    }
    return HttpResponse.json(body)
  })),

  http.get(`${BASE}/deliveries/:id/attempts`, authed((ctx) => {
    const d = db.deliveries.find((x) => x.id === param(ctx, 'id'))
    if (!d || !ownedEvent(ctx.userId, d.event_id)) return error(404, 'DELIVERY_NOT_FOUND', 'The requested delivery does not exist.')
    advance(d)
    return HttpResponse.json(paginate(attemptsFor(d.id), ctx.url))
  })),

  /* api keys */
  http.get(`${BASE}/api-keys`, authed(({ url, userId }) => {
    const items = db.apiKeys
      .filter((k) => k.user_id === userId)
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      .map(({ user_id, ...k }) => k)
    return HttpResponse.json(paginate(items, url))
  })),

  http.post(`${BASE}/api-keys`, writable(async ({ request, userId }) => {
    const { name } = (await request.json()) as { name: string }
    if (!name?.trim()) return error(422, 'VALIDATION_ERROR', 'Name is required.')
    const raw = `wh_live_${uuid().replace(/-/g, '')}`
    const rec = {
      id: uuid(),
      user_id: userId,
      name: name.trim(),
      key_prefix: raw.slice(0, 12),
      last_used_at: null,
      revoked_at: null,
      created_at: new Date().toISOString(),
    }
    db.apiKeys.push(rec)
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { user_id, ...key } = rec
    return HttpResponse.json({ ...key, key: raw }, { status: 201 })
  })),

  http.delete(`${BASE}/api-keys/:id`, writable((ctx) => {
    const k = db.apiKeys.find((x) => x.id === param(ctx, 'id') && x.user_id === ctx.userId)
    if (!k) return error(404, 'API_KEY_NOT_FOUND', 'The requested API key does not exist.')
    k.revoked_at = new Date().toISOString()
    return new HttpResponse(null, { status: 204 })
  })),
]
