import { lazy, Suspense, type ReactNode } from 'react'
import { Navigate, type RouteObject } from 'react-router'
import { AppLayout } from '@/components/layout/app-layout'
import { Skeleton } from '@/components/ui/skeleton'
import LoginPage from '@/pages/auth/login-page'
import RegisterPage from '@/pages/auth/register-page'
import NotFoundPage from '@/pages/not-found-page'
import { RedirectIfAuthed, RequireAuth } from './guards'

const DashboardPage = lazy(() => import('@/pages/dashboard/dashboard-page'))
const EndpointsPage = lazy(() => import('@/pages/endpoints/endpoints-page'))
const EndpointDetailPage = lazy(() => import('@/pages/endpoints/endpoint-detail-page'))
const EventsPage = lazy(() => import('@/pages/events/events-page'))
const EventDetailPage = lazy(() => import('@/pages/events/event-detail-page'))
const DeliveryDetailPage = lazy(() => import('@/pages/events/delivery-detail-page'))
const AnalyticsPage = lazy(() => import('@/pages/analytics/analytics-page'))
const ApiKeysPage = lazy(() => import('@/pages/settings/api-keys-page'))
const SettingsPage = lazy(() => import('@/pages/settings/settings-page'))

function PageFallback() {
  return (
    <div className="grid gap-4" aria-busy>
      <Skeleton className="h-8 w-48" />
      <Skeleton className="h-64" />
    </div>
  )
}

const page = (el: ReactNode) => <Suspense fallback={<PageFallback />}>{el}</Suspense>

export const routes: RouteObject[] = [
  {
    element: <RedirectIfAuthed />,
    children: [
      { path: '/login', element: <LoginPage /> },
      { path: '/register', element: <RegisterPage /> },
    ],
  },
  {
    element: <RequireAuth />,
    children: [
      {
        element: <AppLayout />,
        children: [
          { path: '/', element: <Navigate to="/dashboard" replace /> },
          { path: '/dashboard', element: page(<DashboardPage />) },
          { path: '/endpoints', element: page(<EndpointsPage />) },
          { path: '/endpoints/:id', element: page(<EndpointDetailPage />) },
          { path: '/events', element: page(<EventsPage />) },
          { path: '/events/:id', element: page(<EventDetailPage />) },
          { path: '/deliveries/:id', element: page(<DeliveryDetailPage />) },
          { path: '/analytics', element: page(<AnalyticsPage />) },
          { path: '/settings', element: page(<SettingsPage />) },
          { path: '/settings/api-keys', element: page(<ApiKeysPage />) },
          { path: '*', element: <NotFoundPage /> },
        ],
      },
    ],
  },
]
