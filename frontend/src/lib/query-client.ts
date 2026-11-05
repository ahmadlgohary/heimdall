import { QueryClient } from '@tanstack/react-query'
import { ApiError } from './api-client'

export function createQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 10_000,
        refetchOnWindowFocus: true,
        retry: (count, err) => {
          if (err instanceof ApiError && err.status < 500) return false
          return count < 2
        },
      },
      mutations: { retry: false },
    },
  })
}

/** Poll interval for live delivery views (plan §3.8: 3–5 s). */
export const LIVE_POLL_MS = 4000

export const queryKeys = {
  me: ['me'] as const,
  endpoints: ['endpoints'] as const,
  endpoint: (id: string) => ['endpoints', id] as const,
  events: (filters: object) => ['events', filters] as const,
  event: (id: string) => ['event', id] as const,
  eventPayload: (id: string) => ['event', id, 'payload'] as const,
  eventDeliveries: (id: string) => ['event', id, 'deliveries'] as const,
  delivery: (id: string) => ['delivery', id] as const,
  deliveryAttempts: (id: string) => ['delivery', id, 'attempts'] as const,
  dashboardStats: (range: string) => ['dashboard', 'stats', range] as const,
  dashboardActivity: ['dashboard', 'activity'] as const,
  analytics: (range: string) => ['analytics', range] as const,
  apiKeys: ['api-keys'] as const,
}
