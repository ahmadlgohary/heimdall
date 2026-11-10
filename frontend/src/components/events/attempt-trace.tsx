import { Check, Clock, X } from 'lucide-react'
import { useNow } from '@/hooks/use-now'
import { cn, formatMs } from '@/lib/utils'
import type { Delivery, DeliveryAttempt } from '@/types/api'

function gapLabel(ms: number) {
  const s = Math.round(ms / 1000)
  if (s < 1) return '<1s'
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  const rem = s % 60
  if (m < 60) return rem && m < 5 ? `${m}m ${rem}s` : `${m}m`
  const h = Math.floor(m / 60)
  return `${h}h ${m % 60}m`
}

function countdown(ms: number) {
  if (ms <= 0) return 'due now'
  return `in ${gapLabel(ms)}`
}

/** Segment weight grows with the wait, on a log scale, so 30 s and 30 min both fit. */
const weight = (ms: number) => 1 + Math.log10(1 + ms / 1000)

function attemptOk(a: DeliveryAttempt) {
  return a.http_status != null && a.http_status >= 200 && a.http_status < 300
}

interface AttemptTraceProps {
  delivery: Delivery
  attempts: DeliveryAttempt[]
  selectedId?: string | null
  onSelect?: (attempt: DeliveryAttempt) => void
}

/**
 * Attempt trace: one execution drawn as a wire. Each node is an attempt;
 * the space between nodes is the backoff the worker waited. A pending retry
 * shows as a dashed segment ending in a hollow node with a countdown.
 */
export function AttemptTrace({ delivery, attempts, selectedId, onSelect }: AttemptTraceProps) {
  const now = useNow(1000)
  const sorted = [...attempts].sort((a, b) => a.attempt_number - b.attempt_number)
  const pending =
    delivery.next_attempt_at && (delivery.status === 'retrying' || delivery.status === 'queued')
      ? new Date(delivery.next_attempt_at).getTime()
      : null
  const inFlight = delivery.status === 'delivering'
  const remaining = Math.max(delivery.max_attempts - sorted.length - (pending || inFlight ? 1 : 0), 0)

  if (sorted.length === 0 && !pending && !inFlight) {
    return (
      <div className="flex items-center gap-3 py-4 text-sm text-muted">
        <span className="size-3.5 rounded-full border-[1.5px] border-dashed border-muted" aria-hidden />
        Waiting for the first attempt.
      </div>
    )
  }

  return (
    <div className="-mx-1 overflow-x-auto px-1 pb-1">
      <ol className="flex min-w-[440px] items-start pt-5" aria-label={`Attempts for execution ${delivery.execution_number}`}>
        {sorted.map((a, i) => {
          const ok = attemptOk(a)
          const next = sorted[i + 1]
          const gapTo = next
            ? new Date(next.attempted_at).getTime()
            : pending ?? (inFlight ? now : null)
          const gap = gapTo != null ? gapTo - new Date(a.attempted_at).getTime() : null
          const selected = selectedId === a.id
          return (
            <li key={a.id} className="contents">
              <div className="flex shrink-0 flex-col items-center">
                <button
                  type="button"
                  onClick={() => onSelect?.(a)}
                  aria-pressed={selected}
                  aria-label={`Attempt ${a.attempt_number}: ${
                    a.http_status ? `HTTP ${a.http_status}` : a.error_message ?? 'no response'
                  }, ${formatMs(a.duration_ms)}`}
                  className={cn(
                    'relative grid size-7 place-items-center rounded-full border-2 transition-[box-shadow,transform] outline-none',
                    'focus-visible:ring-3 focus-visible:ring-ring/60 hover:scale-110',
                    ok ? 'border-chart-ok bg-chart-ok text-background' : 'border-chart-fail bg-surface text-chart-fail',
                    selected && 'ring-4 ring-primary-soft',
                  )}
                >
                  {ok ? <Check className="size-3.5" strokeWidth={3} /> : <X className="size-3.5" strokeWidth={3} />}
                </button>
                <div className="mt-2 grid justify-items-center gap-0.5 text-center">
                  <span className={cn('text-xs', selected ? 'text-foreground' : 'text-faint')}>#{a.attempt_number}</span>
                  <span className={cn('mono-tight text-sm font-medium', ok ? 'text-success' : 'text-danger')}>
                    {a.http_status ?? (/timed out|timeout/i.test(a.error_message ?? '') ? 'timeout' : 'error')}
                  </span>
                  <span className="tabular text-xs text-muted">{formatMs(a.duration_ms)}</span>
                </div>
              </div>
              {gap != null && (
                <div className="relative mt-[13px] min-w-14" style={{ flexGrow: weight(gap) }} aria-hidden>
                  <span
                    className={cn(
                      'absolute inset-x-1 top-0 h-0.5 rounded-full',
                      next ? 'bg-border-strong' : cn('wire-dash', inFlight ? 'text-primary' : 'text-warning'),
                    )}
                  />
                  <span className="absolute inset-x-0 -top-5 text-center text-xs text-faint tabular">
                    {next ? `+${gapLabel(gap)}` : ''}
                  </span>
                </div>
              )}
            </li>
          )
        })}

        {(pending || inFlight) && (
          <li className="flex shrink-0 flex-col items-center">
            <span
              className={cn(
                'grid size-7 place-items-center rounded-full border-2 border-dashed',
                inFlight ? 'border-primary text-primary animate-pulse-dot' : 'border-warning text-warning',
              )}
            >
              <Clock className="size-3.5" aria-hidden />
            </span>
            <div className="mt-2 grid justify-items-center gap-0.5 text-center">
              <span className="text-xs text-faint">#{sorted.length + 1}</span>
              <span className={cn('text-sm font-medium', inFlight ? 'text-primary' : 'text-warning')}>
                {inFlight ? 'Sending' : 'Next retry'}
              </span>
              <span className="tabular text-xs text-muted" aria-live="polite">
                {inFlight ? 'now' : countdown(pending! - now)}
              </span>
            </div>
          </li>
        )}

        {remaining > 0 && delivery.status !== 'delivered' && delivery.status !== 'failed' && (
          <li className="mt-[13px] flex flex-1 items-center gap-1.5 pl-2" aria-label={`${remaining} attempts remaining`}>
            {Array.from({ length: remaining }).map((_, i) => (
              <span key={i} className="size-1.5 rounded-full bg-border-strong" aria-hidden />
            ))}
          </li>
        )}
      </ol>
    </div>
  )
}
