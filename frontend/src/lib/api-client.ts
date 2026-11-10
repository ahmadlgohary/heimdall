import type { ApiErrorBody } from '@/types/api'
import { SESSION_EXPIRED_EVENT, tokenStore } from './auth'

export const API_BASE = `${(import.meta.env.VITE_API_URL ?? '').replace(/\/$/, '')}/api/v1`

/** A failure reported by the Heimdall API itself. */
export class ApiError extends Error {
  readonly status: number
  readonly code: string
  readonly details: unknown

  constructor(status: number, code: string, message: string, details: unknown = null) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
    this.details = details
  }
}

/** The API could not be reached at all (offline, CORS, server down). */
export class NetworkError extends Error {
  constructor() {
    super('Can’t reach the Heimdall API. Check your connection and try again.')
    this.name = 'NetworkError'
  }
}

type Query = Record<string, string | number | boolean | null | undefined>

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE'
  body?: unknown
  query?: Query
  /** skip the bearer token and the refresh-on-401 retry */
  anonymous?: boolean
  signal?: AbortSignal
}

function buildUrl(path: string, query?: Query) {
  const url = `${API_BASE}${path}`
  if (!query) return url
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') continue
    params.set(key, String(value))
  }
  const qs = params.toString()
  return qs ? `${url}?${qs}` : url
}

async function parseError(res: Response): Promise<ApiError> {
  let body: Partial<ApiErrorBody> | { detail?: unknown } | null = null
  try {
    body = await res.json()
  } catch {
    /* non-JSON error */
  }
  if (body && 'error' in body && body.error) {
    return new ApiError(res.status, body.error.code, body.error.message, body.error.details)
  }
  // FastAPI's default validation shape, in case it slips through
  if (body && 'detail' in body && body.detail) {
    const detail = body.detail
    const message = typeof detail === 'string' ? detail : 'The request contains invalid fields.'
    return new ApiError(res.status, 'VALIDATION_ERROR', message, detail)
  }
  return new ApiError(res.status, `HTTP_${res.status}`, defaultMessage(res.status))
}

function defaultMessage(status: number) {
  if (status === 401) return 'Your session has ended. Sign in again.'
  if (status === 403) return 'You don’t have access to this resource.'
  if (status === 404) return 'This resource doesn’t exist or was deleted.'
  if (status === 429) return 'Too many requests. Wait a moment and try again.'
  if (status >= 500) return 'The Heimdall API returned an error. Try again shortly.'
  return 'The request couldn’t be completed.'
}

let refreshInFlight: Promise<string | null> | null = null

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Rotate the refresh cookie and get a fresh access token. Deduplicated.
 *
 * Only a 401 means the session is over. A rate limit (429), a server error or a
 * network blip is retried once, so a temporary problem doesn't sign the user out.
 */
export function refreshAccessToken(): Promise<string | null> {
  refreshInFlight ??= (async () => {
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        let res: Response
        try {
          res = await fetch(buildUrl('/auth/refresh'), { method: 'POST', credentials: 'include' })
        } catch {
          if (attempt === 0) {
            await sleep(1000)
            continue
          }
          return null
        }
        if (res.ok) {
          const data = (await res.json()) as { access_token: string }
          tokenStore.set(data.access_token)
          return data.access_token
        }
        const temporary = res.status === 429 || res.status >= 500
        if (!temporary || attempt === 1) return null
        const retryAfter = Number(res.headers.get('retry-after'))
        await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter, 5) * 1000 : 1000)
      }
      return null
    } finally {
      queueMicrotask(() => (refreshInFlight = null))
    }
  })()
  return refreshInFlight
}

async function send(path: string, opts: RequestOptions, token: string | null) {
  const headers: Record<string, string> = { Accept: 'application/json' }
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json'
  if (token && !opts.anonymous) headers.Authorization = `Bearer ${token}`
  try {
    return await fetch(buildUrl(path, opts.query), {
      method: opts.method ?? 'GET',
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      credentials: 'include',
      signal: opts.signal,
    })
  } catch (err) {
    if ((err as Error).name === 'AbortError') throw err
    throw new NetworkError()
  }
}

export async function request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  let res = await send(path, opts, tokenStore.get())

  if (res.status === 401 && !opts.anonymous) {
    const fresh = await refreshAccessToken()
    if (fresh) {
      res = await send(path, opts, fresh)
    } else {
      tokenStore.set(null)
      window.dispatchEvent(new Event(SESSION_EXPIRED_EVENT))
    }
  }

  if (!res.ok) throw await parseError(res)
  if (res.status === 204) return undefined as T
  const text = await res.text()
  return (text ? JSON.parse(text) : undefined) as T
}

export const api = {
  get: <T>(path: string, query?: Query, signal?: AbortSignal) => request<T>(path, { query, signal }),
  post: <T>(path: string, body?: unknown, opts: Omit<RequestOptions, 'method' | 'body'> = {}) =>
    request<T>(path, { ...opts, method: 'POST', body }),
  patch: <T>(path: string, body: unknown) => request<T>(path, { method: 'PATCH', body }),
  delete: <T = void>(path: string) => request<T>(path, { method: 'DELETE' }),
}

/** Human-readable message for any thrown value. */
export function errorMessage(err: unknown): string {
  if (err instanceof ApiError || err instanceof NetworkError) return err.message
  if (err instanceof Error && err.message) return err.message
  return 'Something went wrong.'
}
