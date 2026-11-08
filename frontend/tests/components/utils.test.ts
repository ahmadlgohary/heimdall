import { describe, expect, it, vi } from 'vitest'
import { endpointSchema } from '@/schemas/endpoint'
import { registerSchema } from '@/schemas/auth'
import { formatMs, formatPercent, httpStatusTone, shortId, toCsv } from '@/lib/utils'

describe('formatters', () => {
  it('formats durations and percentages', () => {
    expect(formatMs(142)).toBe('142 ms')
    expect(formatMs(1240)).toBe('1.24 s')
    expect(formatMs(null)).toBe('—')
    expect(formatPercent(0.9971)).toBe('99.7%')
    expect(formatPercent(1)).toBe('100%')
  })

  it('shortens ids for display', () => {
    expect(shortId('82fa19c0-1111-2222-3333-444444444444', 'evt_')).toBe('evt_82fa19c0')
  })

  it('classifies retryable statuses as warnings', () => {
    expect(httpStatusTone(429)).toBe('warning')
    expect(httpStatusTone(404)).toBe('danger')
    expect(httpStatusTone(204)).toBe('success')
  })

  it('escapes CSV values', () => {
    expect(toCsv([{ a: 'x,y', b: 'say "hi"' }])).toBe('a,b\n"x,y","say ""hi"""')
  })
})

describe('schemas', () => {
  it('rejects private destinations in production builds and accepts public HTTPS URLs', () => {
    vi.stubEnv('PROD', true)
    const base = { name: 'x', enabled: true }
    expect(endpointSchema.safeParse({ ...base, url: 'https://169.254.169.254/latest' }).success).toBe(false)
    expect(endpointSchema.safeParse({ ...base, url: 'not a url' }).success).toBe(false)
    expect(endpointSchema.safeParse({ ...base, url: 'https://api.example.com/hooks' }).success).toBe(true)
    vi.unstubAllEnvs()
    // in development the API decides, so local receivers pass the client check
    expect(endpointSchema.safeParse({ ...base, url: 'http://localhost:9000/hooks/ok' }).success).toBe(true)
  })

  it('enforces password strength and matching confirmation', () => {
    expect(registerSchema.safeParse({ email: 'a@b.co', password: 'short', confirm: 'short' }).success).toBe(false)
    expect(registerSchema.safeParse({ email: 'a@b.co', password: 'LongEnough123', confirm: 'Different123' }).success).toBe(false)
    expect(registerSchema.safeParse({ email: 'a@b.co', password: 'LongEnough123', confirm: 'LongEnough123' }).success).toBe(true)
  })
})
