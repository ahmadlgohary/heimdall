/**
 * Access tokens live in memory only. The long-lived refresh token is an
 * HttpOnly cookie managed by the API, so nothing sensitive touches
 * localStorage (plan §3.2).
 */

type Listener = (token: string | null) => void

let accessToken: string | null = null
const listeners = new Set<Listener>()

export const tokenStore = {
  get: () => accessToken,
  set(token: string | null) {
    accessToken = token
    listeners.forEach((l) => l(token))
  },
  subscribe(listener: Listener) {
    listeners.add(listener)
    return () => listeners.delete(listener)
  },
}

/** Fired when a refresh fails and the session is no longer usable. */
export const SESSION_EXPIRED_EVENT = 'heimdall:session-expired'
