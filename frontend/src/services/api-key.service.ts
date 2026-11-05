import { api } from '@/lib/api-client'
import type { ApiKey, ApiKeyCreated, Paginated } from '@/types/api'

export const apiKeyService = {
  list: () => api.get<Paginated<ApiKey>>('/api-keys', { limit: 100 }),
  create: (name: string) => api.post<ApiKeyCreated>('/api-keys', { name }),
  revoke: (id: string) => api.delete(`/api-keys/${id}`),
}
