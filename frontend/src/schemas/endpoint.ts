import { z } from 'zod'

const PRIVATE_HOST =
  /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|0\.0\.0\.0|\[?::1\]?$|metadata\.google\.internal)/i

/**
 * Client-side checks only catch obvious mistakes. The API performs the real
 * SSRF validation, including DNS resolution (plan §3.3).
 */
export const endpointSchema = z.object({
  name: z.string().trim().min(1, 'Give the endpoint a name.').max(100, 'Keep the name under 100 characters.'),
  url: z
    .string()
    .trim()
    .min(1, 'Enter the URL that should receive events.')
    .refine((v) => {
      try {
        const u = new URL(v)
        return u.protocol === 'https:' || u.protocol === 'http:'
      } catch {
        return false
      }
    }, 'Enter a full URL, starting with https://')
    .refine((v) => {
      // In development the API may allow local receivers (ALLOW_PRIVATE_DESTINATIONS);
      // it is the real gate either way.
      if (!import.meta.env.PROD) return true
      try {
        return !PRIVATE_HOST.test(new URL(v).hostname)
      } catch {
        return true
      }
    }, 'Private and local network addresses can’t receive webhooks.'),
  description: z.string().trim().max(500, 'Keep the description under 500 characters.').optional(),
  enabled: z.boolean(),
})

export type EndpointFormValues = z.infer<typeof endpointSchema>

export const apiKeySchema = z.object({
  name: z.string().trim().min(1, 'Name the key so you can recognise it later.').max(100),
})
