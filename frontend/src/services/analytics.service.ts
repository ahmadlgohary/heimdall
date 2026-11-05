import { api } from '@/lib/api-client'
import type { AnalyticsOverview, DashboardActivity, DashboardStats, TimeRange } from '@/types/api'

export const analyticsService = {
  dashboardStats: (range: TimeRange) => api.get<DashboardStats>('/dashboard/stats', { range }),
  dashboardActivity: (limit = 40) => api.get<DashboardActivity>('/dashboard/activity', { limit }),
  overview: (range: TimeRange) => api.get<AnalyticsOverview>('/analytics/overview', { range }),
}
