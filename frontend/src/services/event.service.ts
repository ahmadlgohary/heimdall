import { api } from '@/lib/api-client'
import type {
  Delivery,
  DeliveryAttempt,
  DeliveryDetail,
  EventDetail,
  EventFilters,
  EventSummary,
  Paginated,
} from '@/types/api'

export const eventService = {
  list: (filters: EventFilters) =>
    api.get<Paginated<EventSummary>>('/events', { ...filters } as Record<string, string | number>),
  get: (id: string) => api.get<EventDetail>(`/events/${id}`),
  payload: (id: string) => api.get<unknown>(`/events/${id}/payload`),
  deliveries: (id: string) => api.get<Paginated<Delivery>>(`/events/${id}/deliveries`, { limit: 100 }),
  replay: (id: string) => api.post<Delivery>(`/events/${id}/replay`),
}

export const deliveryService = {
  get: (id: string) => api.get<DeliveryDetail>(`/deliveries/${id}`),
  attempts: (id: string) => api.get<Paginated<DeliveryAttempt>>(`/deliveries/${id}/attempts`, { limit: 100 }),
}
