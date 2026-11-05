import { api } from '@/lib/api-client'
import type {
  Endpoint,
  EndpointInput,
  EndpointWithSecret,
  Paginated,
  TestEventResponse,
} from '@/types/api'

export const endpointService = {
  list: (params: { page?: number; limit?: number; search?: string } = {}) =>
    api.get<Paginated<Endpoint>>('/endpoints', { limit: 100, ...params }),
  get: (id: string) => api.get<Endpoint>(`/endpoints/${id}`),
  create: (body: EndpointInput) => api.post<EndpointWithSecret>('/endpoints', body),
  update: (id: string, body: Partial<EndpointInput>) => api.patch<Endpoint>(`/endpoints/${id}`, body),
  remove: (id: string) => api.delete(`/endpoints/${id}`),
  rotateSecret: (id: string) => api.post<{ signing_secret: string }>(`/endpoints/${id}/rotate-secret`),
  sendTest: (id: string) => api.post<TestEventResponse>(`/endpoints/${id}/test`),
}
