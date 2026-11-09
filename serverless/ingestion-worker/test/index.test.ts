import { env, exports } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import { type Bindings, handleRequest } from '../src/index'

const ENDPOINT = '2b1f8f4e-1d1a-4a51-9c39-0b5f3c0d2f11'
const KEY = 'wh_live_abc123'
const bindings: Bindings = {
  API_ORIGIN: 'https://api.test/',
  WORKER_SHARED_SECRET: 'test-worker-secret',
  MAX_BODY_BYTES: '1024',
  UPSTREAM_TIMEOUT_MS: '200',
}

function ingestRequest(
  body: BodyInit | null = JSON.stringify({ event_type: 'order.created', data: { order_id: 'ORD-1001' } }),
  headers: Record<string, string> = {},
  path = `/${ENDPOINT}`,
) {
  return new Request(`https://ingest.test${path}`, {
    method: 'POST',
    body,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}`, ...headers },
  })
}

/** A fake API that records what it received. */
function fakeApi(response: Response | (() => Promise<Response>) = jsonResponse(202, { event_id: 'e1', status: 'queued' })) {
  const calls: Request[] = []
  const upstream = async (req: Request) => {
    calls.push(req)
    return typeof response === 'function' ? response() : response.clone()
  }
  return { calls, upstream }
}

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}) {
  return Response.json(body, { status, headers })
}

async function errorCode(res: Response) {
  return ((await res.json()) as { error: { code: string } }).error.code
}

describe('forwarding', () => {
  it('forwards the original bytes with the shared secret, key and idempotency key', async () => {
    const raw = '{"event_type":"order.created",  "data":{"amount":129.99}}' // odd spacing must survive
    const api = fakeApi(jsonResponse(202, { event_id: 'e1', status: 'queued' }, { 'x-request-id': 'req-1' }))
    const res = await handleRequest(
      ingestRequest(raw, { 'Idempotency-Key': 'order-1001', 'CF-Connecting-IP': '203.0.113.9', 'CF-Ray': 'ray-1' }),
      bindings,
      api.upstream,
    )

    expect(res.status).toBe(202)
    expect(await res.json()).toEqual({ event_id: 'e1', status: 'queued' })
    expect(res.headers.get('x-request-id')).toBe('req-1')

    const [sent] = api.calls
    expect(sent.method).toBe('POST')
    expect(sent.url).toBe(`https://api.test/api/v1/internal/ingest/${ENDPOINT}`)
    expect(sent.headers.get('x-worker-secret')).toBe('test-worker-secret')
    expect(sent.headers.get('authorization')).toBe(`Bearer ${KEY}`)
    expect(sent.headers.get('idempotency-key')).toBe('order-1001')
    expect(sent.headers.get('x-forwarded-for')).toBe('203.0.113.9')
    expect(sent.headers.get('x-request-id')).toBe('ray-1')
    expect(sent.headers.get('content-type')).toBe('application/json')
    expect(await sent.text()).toBe(raw)
  })

  it('relays API errors and idempotent replays unchanged', async () => {
    const replay = fakeApi(jsonResponse(200, { event_id: 'e1' }, { 'idempotent-replayed': 'true' }))
    const res = await handleRequest(ingestRequest(), bindings, replay.upstream)
    expect(res.status).toBe(200)
    expect(res.headers.get('idempotent-replayed')).toBe('true')

    for (const [status, code] of [
      [401, 'API_KEY_INVALID'],
      [404, 'ENDPOINT_NOT_FOUND'],
      [409, 'ENDPOINT_DISABLED'],
      [409, 'IDEMPOTENCY_CONFLICT'],
      [429, 'RATE_LIMITED'],
      [502, 'STORAGE_UNAVAILABLE'],
    ] as const) {
      const api = fakeApi(
        jsonResponse(status, { error: { code, message: 'x', details: null } }, status === 429 ? { 'retry-after': '7' } : {}),
      )
      const relayed = await handleRequest(ingestRequest(), bindings, api.upstream)
      expect(relayed.status).toBe(status)
      expect(await errorCode(relayed)).toBe(code)
      if (status === 429) expect(relayed.headers.get('retry-after')).toBe('7')
    }
  })

  it('does not leak upstream headers like cookies', async () => {
    const api = fakeApi(jsonResponse(202, { ok: true }, { 'set-cookie': 'session=1', server: 'uvicorn' }))
    const res = await handleRequest(ingestRequest(), bindings, api.upstream)
    expect(res.headers.get('set-cookie')).toBeNull()
    expect(res.headers.get('server')).toBeNull()
  })
})

describe('edge validation (rejected before reaching the API)', () => {
  const cases: [string, Request, number, string][] = [
    ['wrong content type', ingestRequest('{}', { 'Content-Type': 'text/plain' }), 415, 'UNSUPPORTED_MEDIA_TYPE'],
    ['missing API key', ingestRequest(undefined, { Authorization: '' }), 401, 'API_KEY_MISSING'],
    ['non-bearer auth', ingestRequest(undefined, { Authorization: `Basic ${KEY}` }), 401, 'API_KEY_MISSING'],
    ['malformed API key', ingestRequest(undefined, { Authorization: 'Bearer sk_test_123' }), 401, 'API_KEY_INVALID'],
    ['empty body', ingestRequest(''), 400, 'INVALID_JSON'],
    ['invalid JSON', ingestRequest('{"event_type": '), 400, 'INVALID_JSON'],
    ['JSON array', ingestRequest('[1,2]'), 422, 'VALIDATION_ERROR'],
    ['missing event_type', ingestRequest('{"data":{}}'), 422, 'VALIDATION_ERROR'],
    ['bad event_type', ingestRequest('{"event_type":"has spaces"}'), 422, 'VALIDATION_ERROR'],
    ['oversized Idempotency-Key', ingestRequest(undefined, { 'Idempotency-Key': 'x'.repeat(256) }), 400, 'INVALID_IDEMPOTENCY_KEY'],
  ]
  for (const [name, request, status, code] of cases) {
    it(`rejects ${name}`, async () => {
      const api = fakeApi()
      const res = await handleRequest(request, bindings, api.upstream)
      expect(res.status).toBe(status)
      expect(await errorCode(res)).toBe(code)
      expect(api.calls).toHaveLength(0)
    })
  }

  it('enforces the size limit from Content-Length and from the actual stream', async () => {
    const big = JSON.stringify({ event_type: 'bulk', data: 'x'.repeat(2000) })
    const api = fakeApi()
    const declared = await handleRequest(ingestRequest(big), bindings, api.upstream)
    expect(declared.status).toBe(413)

    // a streamed body has no Content-Length: the limit must still hold
    const stream = new ReadableStream({
      start(controller) {
        for (let i = 0; i < 10; i++) controller.enqueue(new TextEncoder().encode('x'.repeat(200)))
        controller.close()
      },
    })
    const streamed = await handleRequest(ingestRequest(stream), bindings, api.upstream)
    expect(streamed.status).toBe(413)
    expect(await errorCode(streamed)).toBe('PAYLOAD_TOO_LARGE')
    expect(api.calls).toHaveLength(0)
  })

  it('only routes POST /{uuid}', async () => {
    const api = fakeApi()
    expect((await handleRequest(ingestRequest(undefined, {}, '/not-a-uuid'), bindings, api.upstream)).status).toBe(404)
    expect((await handleRequest(ingestRequest(undefined, {}, '/'), bindings, api.upstream)).status).toBe(404)
    const get = await handleRequest(new Request(`https://ingest.test/${ENDPOINT}`), bindings, api.upstream)
    expect(get.status).toBe(405)
    expect(get.headers.get('allow')).toBe('POST')
    expect(api.calls).toHaveLength(0)
  })
})

describe('when the API is unavailable', () => {
  it('returns 502 for network errors', async () => {
    const res = await handleRequest(ingestRequest(), bindings, async () => {
      throw new TypeError('connection refused')
    })
    expect(res.status).toBe(502)
    expect(await errorCode(res)).toBe('UPSTREAM_UNAVAILABLE')
  })

  it('returns 504 when the API is too slow', async () => {
    const res = await handleRequest(ingestRequest(), bindings, (req) =>
      new Promise((_, reject) => req.signal.addEventListener('abort', () => reject(req.signal.reason))),
    )
    expect(res.status).toBe(504)
    expect(await errorCode(res)).toBe('UPSTREAM_TIMEOUT')
  })

  it('wraps non-JSON origin errors (e.g. a proxy’s HTML 502) and redirects', async () => {
    for (const response of [
      new Response('<html>Bad Gateway</html>', { status: 502, headers: { 'content-type': 'text/html' } }),
      new Response(null, { status: 302, headers: { location: 'https://elsewhere.test' } }),
    ]) {
      const res = await handleRequest(ingestRequest(), bindings, async () => response)
      expect(res.status).toBe(502)
      expect(await errorCode(res)).toBe('UPSTREAM_UNAVAILABLE')
    }
  })

  it('hides gateway misconfiguration from callers', async () => {
    for (const [status, code] of [
      [401, 'WORKER_UNAUTHORIZED'], // wrong shared secret
      [404, 'NOT_FOUND'], // internal route disabled on the API
    ] as const) {
      const api = fakeApi(jsonResponse(status, { error: { code, message: 'x', details: null } }))
      const res = await handleRequest(ingestRequest(), bindings, api.upstream)
      expect(res.status).toBe(502)
      expect(await errorCode(res)).toBe('GATEWAY_MISCONFIGURED')
    }
    const missing = await handleRequest(ingestRequest(), { ...bindings, WORKER_SHARED_SECRET: '' }, fakeApi().upstream)
    expect(missing.status).toBe(500)
  })
})

describe('deployed worker entry point (workerd, wrangler.toml bindings)', () => {
  it('serves /health', async () => {
    const res = await exports.default.fetch('https://ingest.test/health')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ status: 'ok' })
  })

  it('validates at the edge using the configured bindings', async () => {
    expect(env.MAX_BODY_BYTES).toBe('262144')
    const res = await exports.default.fetch(
      new Request(`https://ingest.test/${ENDPOINT}`, {
        method: 'POST',
        body: '{}',
        headers: { 'Content-Type': 'application/json' },
      }),
    )
    expect(res.status).toBe(401)
    expect(await errorCode(res)).toBe('API_KEY_MISSING')
  })
})
