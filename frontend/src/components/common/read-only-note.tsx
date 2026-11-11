import { Lock } from 'lucide-react'
import type { ReactNode } from 'react'
import { useNavigate } from 'react-router'
import { Button } from '@/components/ui/button'
import { useAuth } from '@/contexts/auth-context'
import { useReadOnly } from '@/hooks/use-read-only'
import { cn } from '@/lib/utils'

/** Shown on pages with editing controls when the shared demo account is signed in. */
export function ReadOnlyNote({ className, children }: { className?: string; children?: ReactNode }) {
  const readOnly = useReadOnly()
  const { logout } = useAuth()
  const navigate = useNavigate()
  if (!readOnly) return null
  return (
    <div
      className={cn(
        'mb-5 flex flex-col gap-3 rounded-lg border border-dashed border-border-strong px-4 py-3 sm:flex-row sm:items-center sm:justify-between',
        className,
      )}
    >
      <p className="flex items-start gap-2.5 text-sm text-muted">
        <Lock className="mt-0.5 size-4 shrink-0" aria-hidden />
        <span>
          <span className="font-medium text-foreground">Read-only demo.</span>{' '}
          {children ?? 'You can look around, but changes are switched off and nothing is saved.'}
        </span>
      </p>
      <Button
        variant="secondary"
        size="sm"
        className="shrink-0"
        onClick={async () => {
          await logout()
          navigate('/register')
        }}
      >
        Create your own account
      </Button>
    </div>
  )
}
