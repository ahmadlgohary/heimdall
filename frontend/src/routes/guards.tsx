import { Navigate, Outlet, useLocation } from 'react-router'
import { LogoMark } from '@/components/layout/logo'
import { useAuth } from '@/contexts/auth-context'

function BootScreen() {
  return (
    <div className="grid min-h-dvh place-items-center" role="status" aria-label="Loading">
      <LogoMark className="size-9 animate-pulse" />
    </div>
  )
}

export function RequireAuth() {
  const { status } = useAuth()
  const location = useLocation()
  if (status === 'loading') return <BootScreen />
  if (status === 'anonymous') {
    return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />
  }
  return <Outlet />
}

export function RedirectIfAuthed() {
  const { status } = useAuth()
  if (status === 'loading') return <BootScreen />
  if (status === 'authenticated') return <Navigate to="/dashboard" replace />
  return <Outlet />
}
