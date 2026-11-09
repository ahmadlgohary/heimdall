/**
 * Heimdall edge ingestion gateway (plan §7).
 *
 *   POST https://ingest.<domain>/{endpoint_id}
 *     → validate content type, size, headers and basic body shape at the edge
 *     → forward the original bytes to  POST {API_ORIGIN}/api/v1/internal/ingest/{endpoint_id}
 *       with the shared secret, the caller's API key and Idempotency-Key
 *     → relay the API's response to the caller
 *
 * This is not a second event processor: the API still authenticates the key and owns
 * persistence, idempotency and queuing. The checks here reject obviously bad traffic
 * before it costs an origin round-trip.
 */

export interface Bindings {
  API_ORIGIN: string
  WORKER_SHARED_SECRET: string
  MAX_BODY_BYTES?: string
  UPSTREAM_TIMEOUT_MS?: string
}

type Upstream = (input: Request) => Promise<Response>

const DEFAULT_MAX_BODY_BYTES = 256 * 1024
const DEFAULT_TIMEOUT_MS = 10_000
const API_KEY_PREFIX = 'wh_live_'
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const EVENT_TYPE_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,149}$/
/** Response headers from the API worth passing through to the caller. */
const RELAYED_HEADERS = ['content-type', 'idempotent-replayed', 'retry-after', 'x-request-id']

/** Same error shape as the API: {"error": {"code", "message", "details"}}. */
export function errorResponse(status: number, code: string, message: string, headers: HeadersInit = {}): Response {
  return Response.json({ error: { code, message, details: null } }, { status, headers })
}

class GatewayError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly headers: HeadersInit = {},
  ) {
    super(message)
  }
}

function positiveInt(value: string | undefined, fallback: number): number {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback
}

/** Read at most `limit` bytes; stop reading (and reject) as soon as the stream exceeds it. */
async function readBody(request: Request, limit: number): Promise<Uint8Array> {
  const declared = request.headers.get('content-length')
  if (declared && Number(declared) > limit) {
    throw new GatewayError(413, 'PAYLOAD_TOO_LARGE', `Payload exceeds the ${limit / 1024} KB limit.`)
  }
  if (!request.body) return new Uint8Array()
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > limit) {
      await reader.cancel()
      throw new GatewayError(413, 'PAYLOAD_TOO_LARGE', `Payload exceeds the ${limit / 1024} KB limit.`)
    }
    chunks.push(value)
  }
  const body = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    body.set(chunk, offset)
    offset += chunk.byteLength
  }
  return body
}

function validateHeaders(request: Request): void {
  const contentType = request.headers.get('content-type')?.split(';')[0].trim().toLowerCase()
  if (contentType !== 'application/json') {
    throw new GatewayError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Content-Type must be application/json.')
  }
  const [scheme, key] = (request.headers.get('authorization') ?? '').trim().split(/\s+/, 2)
  if (scheme?.toLowerCase() !== 'bearer' || !key) {
    throw new GatewayError(401, 'API_KEY_MISSING', 'Missing API key. Send it as `Authorization: Bearer <key>`.', {
      'WWW-Authenticate': 'Bearer',
    })
  }
  if (!key.startsWith(API_KEY_PREFIX)) {
    throw new GatewayError(401, 'API_KEY_INVALID', 'Invalid API key.', { 'WWW-Authenticate': 'Bearer' })
  }
  const idempotencyKey = request.headers.get('idempotency-key')
  if (idempotencyKey !== null && (idempotencyKey.length === 0 || idempotencyKey.length > 255)) {
    throw new GatewayError(400, 'INVALID_IDEMPOTENCY_KEY', 'Idempotency-Key must be 1–255 characters.')
  }
}

/** Basic structure only; the API performs full validation. */
function validateBody(body: Uint8Array): void {
  if (body.byteLength === 0) throw new GatewayError(400, 'INVALID_JSON', 'Request body is empty.')
  let parsed: unknown
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(body))
  } catch {
    throw new GatewayError(400, 'INVALID_JSON', 'Request body isn’t valid JSON.')
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new GatewayError(422, 'VALIDATION_ERROR', 'Body must be a JSON object with an event_type.')
  }
  const eventType = (parsed as { event_type?: unknown }).event_type
  if (typeof eventType !== 'string' || !EVENT_TYPE_RE.test(eventType)) {
    throw new GatewayError(
      422,
      'VALIDATION_ERROR',
      "event_type is required: 1–150 characters of letters, digits, '.', '_', ':' or '-'.",
    )
  }
}

async function forward(
  request: Request,
  endpointId: string,
  body: Uint8Array,
  env: Bindings,
  upstream: Upstream,
): Promise<Response> {
  const origin = env.API_ORIGIN.replace(/\/+$/, '')
  const headers = new Headers({
    'Content-Type': 'application/json',
    Authorization: request.headers.get('authorization') ?? '',
    'X-Worker-Secret': env.WORKER_SHARED_SECRET,
  })
  const idempotencyKey = request.headers.get('idempotency-key')
  if (idempotencyKey) headers.set('Idempotency-Key', idempotencyKey)
  const clientIp = request.headers.get('cf-connecting-ip')
  if (clientIp) headers.set('X-Forwarded-For', clientIp)
  const requestId = request.headers.get('cf-ray') ?? crypto.randomUUID()
  headers.set('X-Request-ID', requestId)

  const timeoutMs = positiveInt(env.UPSTREAM_TIMEOUT_MS, DEFAULT_TIMEOUT_MS)
  let response: Response
  try {
    response = await upstream(
      new Request(`${origin}/api/v1/internal/ingest/${endpointId}`, {
        method: 'POST',
        headers,
        body,
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
      }),
    )
  } catch (err) {
    const timedOut = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')
    console.error(JSON.stringify({ msg: 'upstream request failed', requestId, error: String(err) }))
    return timedOut
      ? errorResponse(504, 'UPSTREAM_TIMEOUT', 'The ingestion API didn’t respond in time. Retry the request.')
      : errorResponse(502, 'UPSTREAM_UNAVAILABLE', 'The ingestion API is unavailable. Retry the request.')
  }

  return relay(response, requestId)
}

async function relay(response: Response, requestId: string): Promise<Response> {
  const isJson = response.headers.get('content-type')?.includes('application/json') ?? false
  const text = await response.text()

  // Anything that isn't the API's own JSON (a proxy's HTML 502, a redirect) is an origin problem.
  if (!isJson || (response.status >= 300 && response.status < 400)) {
    console.error(JSON.stringify({ msg: 'unexpected upstream response', requestId, status: response.status }))
    return errorResponse(502, 'UPSTREAM_UNAVAILABLE', 'The ingestion API is unavailable. Retry the request.')
  }

  // Our own credentials were rejected, or the internal route is disabled: a deployment
  // problem the caller can't fix, so don't relay the details.
  if (response.status === 401 || response.status === 404) {
    const code = safeErrorCode(text)
    if (code === 'WORKER_UNAUTHORIZED' || (response.status === 404 && code === 'NOT_FOUND')) {
      console.error(JSON.stringify({ msg: 'gateway misconfigured', requestId, upstreamCode: code }))
      return errorResponse(502, 'GATEWAY_MISCONFIGURED', 'The ingestion gateway is misconfigured.')
    }
  }

  const headers = new Headers()
  for (const name of RELAYED_HEADERS) {
    const value = response.headers.get(name)
    if (value) headers.set(name, value)
  }
  if (!headers.has('x-request-id')) headers.set('x-request-id', requestId)
  return new Response(text, { status: response.status, headers })
}

function safeErrorCode(text: string): string | undefined {
  try {
    return (JSON.parse(text) as { error?: { code?: string } }).error?.code
  } catch {
    return undefined
  }
}

export async function handleRequest(request: Request, env: Bindings, upstream: Upstream = fetch): Promise<Response> {
  const url = new URL(request.url)
  const path = url.pathname.replace(/\/+$/, '') || '/'

  if (path === '/health' && (request.method === 'GET' || request.method === 'HEAD')) {
    return Response.json({ status: 'ok' })
  }

  const endpointId = path.slice(1)
  if (!UUID_RE.test(endpointId)) {
    return errorResponse(404, 'NOT_FOUND', 'Send events to /{endpoint_id}.')
  }
  if (request.method !== 'POST') {
    return errorResponse(405, 'METHOD_NOT_ALLOWED', 'Use POST to send events.', { Allow: 'POST' })
  }
  if (!env.API_ORIGIN || !env.WORKER_SHARED_SECRET) {
    console.error(JSON.stringify({ msg: 'missing API_ORIGIN or WORKER_SHARED_SECRET' }))
    return errorResponse(500, 'GATEWAY_MISCONFIGURED', 'The ingestion gateway is misconfigured.')
  }

  try {
    validateHeaders(request)
    const body = await readBody(request, positiveInt(env.MAX_BODY_BYTES, DEFAULT_MAX_BODY_BYTES))
    validateBody(body)
    return await forward(request, endpointId.toLowerCase(), body, env, upstream)
  } catch (err) {
    if (err instanceof GatewayError) return errorResponse(err.status, err.code, err.message, err.headers)
    throw err
  }
}

export default {
  fetch(request, env) {
    return handleRequest(request, env)
  },
} satisfies ExportedHandler<Cloudflare.Env>
