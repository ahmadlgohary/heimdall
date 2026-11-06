import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { LIVE_POLL_MS, queryKeys } from '@/lib/query-client'
import { analyticsService } from '@/services/analytics.service'
import type { TimeRange } from '@/types/api'

export function useDashboardStats(range: TimeRange) {
  return useQuery({
    queryKey: queryKeys.dashboardStats(range),
    queryFn: () => analyticsService.dashboardStats(range),
    placeholderData: keepPreviousData,
    refetchInterval: 15_000,
  })
}

export function useDashboardActivity() {
  return useQuery({
    queryKey: queryKeys.dashboardActivity,
    queryFn: () => analyticsService.dashboardActivity(60),
    refetchInterval: LIVE_POLL_MS,
  })
}

export function useAnalytics(range: TimeRange) {
  return useQuery({
    queryKey: queryKeys.analytics(range),
    queryFn: () => analyticsService.overview(range),
    placeholderData: keepPreviousData,
  })
}
