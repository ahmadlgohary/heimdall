import { http, HttpResponse } from 'msw'
import { describe, expect, it } from 'vitest'
import { refreshAccessToken } from '@/lib/api-client'
import { server } from '../setup'

describe('session refresh', () => {
  it('retries once after a rate limit instead of signing the user out', async () => {
    let calls = 0
    server.use(
      http.post('*/api/v1/auth/refresh', () => {
        calls++
        return calls === 1
          ? HttpResponse.json({ error: { code: 'RATE_LIMITED' } }, { status: 429, headers: { 'Retry-After': '1' } })
          : HttpResponse.json({ access_token: 'fresh', token_type: 'bearer' })
      }),
    )
    await expect(refreshAccessToken()).resolves.toBe('fresh')
    expect(calls).toBe(2)
  })

  it('treats 401 as the end of the session, without retrying', async () => {
    let calls = 0
    server.use(
      http.post('*/api/v1/auth/refresh', () => {
        calls++
        return HttpResponse.json({ error: { code: 'REFRESH_INVALID' } }, { status: 401 })
      }),
    )
    await expect(refreshAccessToken()).resolves.toBeNull()
    expect(calls).toBe(1)
  })
})
