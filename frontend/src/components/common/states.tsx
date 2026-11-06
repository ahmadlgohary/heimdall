import { AlertTriangle, RotateCw, WifiOff } from 'lucide-react'
import type { ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { ApiError, NetworkError, errorMessage } from '@/lib/api-client'
import { cn } from '@/lib/utils'

interface EmptyStateProps {
  title: string
  description?: ReactNode
  action?: ReactNode
  icon?: ReactNode
  className?: string
}

export function EmptyState({ title, description, action, icon, className }: EmptyStateProps) {
  return (
    <div className={cn('flex flex-col items-center justify-center px-6 py-14 text-center', className)}>
      {icon && (
        <div className="mb-4 grid size-11 place-items-center rounded-lg border border-border-strong bg-sunken text-muted [&_svg]:size-5">
          {icon}
        </div>
      )}
      <h3 className="text-lg font-semibold">{title}</h3>
      {description && <p className="mt-1.5 max-w-sm text-base text-muted">{description}</p>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  )
}

/**
 * An error raised by Heimdall itself (API down, bad request). Distinct from a
 * destination failure, which is shown as delivery data, not as an error state.
 */
export function ErrorState({ error, onRetry, className }: { error: unknown; onRetry?: () => void; className?: string }) {
  const offline = error instanceof NetworkError
  const title = offline
    ? 'Heimdall API unreachable'
    : error instanceof ApiError && error.status === 404
      ? 'Not found'
      : 'Couldn’t load this data'
  return (
    <div role="alert" className={cn('flex flex-col items-center justify-center px-6 py-12 text-center', className)}>
      <div className="mb-4 grid size-11 place-items-center rounded-lg border border-danger/30 bg-danger-soft text-danger [&_svg]:size-5">
        {offline ? <WifiOff /> : <AlertTriangle />}
      </div>
      <h3 className="text-lg font-semibold">{title}</h3>
      <p className="mt-1.5 max-w-sm text-base text-muted">{errorMessage(error)}</p>
      {error instanceof ApiError && (
        <code className="mono-tight mt-2 text-xs text-faint">
          {error.status} {error.code}
        </code>
      )}
      {onRetry && (
        <Button variant="secondary" size="sm" className="mt-5" onClick={onRetry}>
          <RotateCw /> Try again
        </Button>
      )}
    </div>
  )
}
