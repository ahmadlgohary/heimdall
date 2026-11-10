import { ArrowUpRight, Hand, Zap } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Link } from 'react-router'
import { AttemptDetail } from '@/components/deliveries/attempt-detail'
import { StatusPill } from '@/components/common/status'
import { Skeleton } from '@/components/ui/skeleton'
import { useDeliveryAttempts } from '@/hooks/use-events'
import { cn, formatShortTime } from '@/lib/utils'
import type { Delivery } from '@/types/api'
import { AttemptTrace } from './attempt-trace'

const LIVE = new Set(['queued', 'delivering', 'retrying'])

/** One execution of an event: its trace, and the attempt you select. */
export function ExecutionBlock({ delivery, defaultOpen }: { delivery: Delivery; defaultOpen?: boolean }) {
  const live = LIVE.has(delivery.status)
  const { data, isPending, refetch } = useDeliveryAttempts(delivery.id, live)
  // the delivery moved on (new attempt or final state): make sure attempts catch up
  useEffect(() => {
    void refetch()
  }, [delivery.status, delivery.current_attempt, refetch])
  const attempts = data?.items ?? []
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [open, setOpen] = useState(!!defaultOpen)
  // the latest attempt is selected until the user picks another
  const selected = attempts.find((a) => a.id === selectedId) ?? attempts[attempts.length - 1]

  return (
    <article className="border-b border-border last:border-0">
      <header className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 pt-4 sm:px-5">
        <h3 className="text-base font-semibold">Execution {delivery.execution_number}</h3>
        <span className="inline-flex items-center gap-1 text-sm text-muted">
          {delivery.trigger_type === 'manual' ? <Hand className="size-3.5" aria-hidden /> : <Zap className="size-3.5" aria-hidden />}
          {delivery.trigger_type === 'manual' ? 'Manual replay' : 'Automatic'}
        </span>
        <span className="tabular text-sm text-faint">{formatShortTime(delivery.created_at)}</span>
        <span className="ml-auto flex items-center gap-2">
          <StatusPill status={delivery.status} />
          <Link
            to={`/deliveries/${delivery.id}`}
            className="inline-flex items-center gap-0.5 text-sm text-muted hover:text-primary"
            aria-label={`Open delivery for execution ${delivery.execution_number}`}
          >
            Details <ArrowUpRight className="size-3.5" aria-hidden />
          </Link>
        </span>
      </header>

      <div className="px-4 pt-2 pb-4 sm:px-5">
        {isPending ? (
          <Skeleton className="mt-4 h-20" />
        ) : (
          <AttemptTrace
            delivery={delivery}
            attempts={attempts}
            selectedId={open ? selected?.id : null}
            onSelect={(a) => {
              if (open && a.id === selected?.id) {
                setOpen(false)
              } else {
                setSelectedId(a.id)
                setOpen(true)
              }
            }}
          />
        )}
        {attempts.length > 0 && (
          <button
            type="button"
            onClick={() => setOpen((o) => !o)}
            aria-expanded={open}
            className={cn('mt-3 text-sm font-medium text-primary hover:underline', open && 'text-muted')}
          >
            {open ? 'Hide response' : 'Show response'}
          </button>
        )}
        {open && selected && (
          <div className="mt-4 animate-fade-in rounded-md border border-border bg-background/40 p-4">
            <AttemptDetail
              attempt={selected}
              final={delivery.status === 'failed' && selected.id === attempts[attempts.length - 1]?.id}
            />
          </div>
        )}
      </div>
    </article>
  )
}
