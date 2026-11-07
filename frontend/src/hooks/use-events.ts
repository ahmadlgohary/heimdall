import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { LIVE_POLL_MS, queryKeys } from '@/lib/query-client'
import { deliveryService, eventService } from '@/services/event.service'
import type { EventFilters, EventStatus } from '@/types/api'

const SETTLED: EventStatus[] = ['delivered', 'failed']
const isSettled = (s?: EventStatus) => !!s && SETTLED.includes(s)

export function useEvents(filters: EventFilters) {
  return useQuery({
    queryKey: queryKeys.events(filters),
    queryFn: () => eventService.list(filters),
    placeholderData: keepPreviousData,
    refetchInterval: LIVE_POLL_MS,
  })
}

/** Polls while the event is still in flight; stops once it settles. */
export function useEvent(id: string) {
  return useQuery({
    queryKey: queryKeys.event(id),
    queryFn: () => eventService.get(id),
    refetchInterval: (q) => (isSettled(q.state.data?.status) ? false : LIVE_POLL_MS),
  })
}

export function useEventPayload(id: string) {
  return useQuery({ queryKey: queryKeys.eventPayload(id), queryFn: () => eventService.payload(id), staleTime: Infinity })
}

/**
 * Polls while the event is live *or* any execution in our own data is unsettled,
 * so the final transition is always fetched even if the event query sees it first.
 */
export function useEventDeliveries(id: string, live: boolean) {
  return useQuery({
    queryKey: queryKeys.eventDeliveries(id),
    queryFn: () => eventService.deliveries(id),
    refetchInterval: (q) =>
      live || q.state.data?.items.some((d) => !isSettled(d.status)) ? LIVE_POLL_MS : false,
  })
}

export function useDelivery(id: string) {
  return useQuery({
    queryKey: queryKeys.delivery(id),
    queryFn: () => deliveryService.get(id),
    refetchInterval: (q) => (isSettled(q.state.data?.status) ? false : LIVE_POLL_MS),
  })
}

export function useDeliveryAttempts(id: string, live: boolean) {
  return useQuery({
    queryKey: queryKeys.deliveryAttempts(id),
    queryFn: () => deliveryService.attempts(id),
    refetchInterval: live ? LIVE_POLL_MS : false,
  })
}

export function useReplayEvent(eventId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: () => eventService.replay(eventId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.event(eventId) })
      qc.invalidateQueries({ queryKey: ['events'] })
    },
  })
}
