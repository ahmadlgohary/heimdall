import { format } from 'date-fns'
import { Link } from 'react-router'
import { Tooltip } from '@/components/ui/tooltip'
import { HttpCode, statusLabel } from '@/components/common/status'
import { useNow } from '@/hooks/use-now'
import { cn, formatMs, formatShortTime } from '@/lib/utils'
import type { ActivityItem } from '@/types/api'

/** Fit the window to the data with a little headroom, never under 15 minutes. */
function fitSpan(ms: number) {
  return Math.max(ms * 1.04, 15 * 60_000)
}

function edgeLabel(t: number, span: number) {
  return format(new Date(t), span > 20 * 3_600_000 ? 'd MMM, HH:mm' : 'HH:mm')
}

/** Tick height from response time — log scale so 40 ms and 4 s both read. */
function tickHeight(ms: number | null) {
  if (ms == null) return 10
  const t = Math.min(Math.log10(Math.max(ms, 10)) - 1, 3) / 3 // 10ms→0, 10s→1
  return 10 + t * 34
}

const UP = new Set(['delivered', 'delivering'])
const DOWN = new Set(['failed', 'retrying'])

const TICK_COLOR: Record<string, string> = {
  delivered: 'bg-chart-ok',
  delivering: 'bg-primary',
  failed: 'bg-chart-fail',
  retrying: 'bg-warning',
}

/**
 * The delivery wire: every recent delivery is a tick on a timeline.
 * Successes rise above the line, failures drop below it, and tick length
 * follows response time. Position and direction carry status, so red/green
 * is never the only cue.
 */
export function DeliveryWire({ items, className }: { items: ActivityItem[]; className?: string }) {
  const now = useNow(5000)
  const earliest = items.reduce((m, i) => Math.min(m, new Date(i.created_at).getTime()), now)
  const span = fitSpan(now - earliest)
  const start = now - span

  const up = items.filter((i) => UP.has(i.status)).length
  const down = items.filter((i) => DOWN.has(i.status)).length

  return (
    <div className={cn('relative', className)}>
      <p className="sr-only">
        {items.length} recent deliveries: {up} succeeded or in progress, {down} failed or retrying.
      </p>
      <div className="relative h-28" role="list" aria-label="Recent deliveries over time">
        {/* gridlines at quarters */}
        {[0.25, 0.5, 0.75].map((f) => (
          <span key={f} aria-hidden className="absolute inset-y-2 w-px bg-border/60" style={{ left: `${f * 100}%` }} />
        ))}
        {/* the wire */}
        <span aria-hidden className="absolute inset-x-0 top-1/2 h-px bg-border-strong" />
        <span aria-hidden className="absolute top-1/2 right-0 size-2 translate-x-1/2 -translate-y-1/2 rounded-full bg-primary animate-pulse-dot text-primary" />

        <div className="absolute inset-0 animate-draw">
          {items.map((item) => {
            const t = new Date(item.created_at).getTime()
            const x = Math.min(Math.max((t - start) / span, 0), 1)
            const h = tickHeight(item.duration_ms)
            const dir = UP.has(item.status) ? 'up' : DOWN.has(item.status) ? 'down' : 'flat'
            const label = `${item.event_type} to ${item.endpoint_name}: ${statusLabel(item.status)}${
              item.http_status ? `, HTTP ${item.http_status}` : ''
            }${item.duration_ms != null ? `, ${formatMs(item.duration_ms)}` : ''}, ${formatShortTime(item.created_at)}`
            return (
              <Tooltip
                key={`${item.event_id}-${item.delivery_id}`}
                content={
                  <div className="grid gap-0.5 py-0.5">
                    <span className="font-medium">{item.event_type}</span>
                    <span className="text-muted">{item.endpoint_name}</span>
                    <span className="flex items-center gap-2">
                      <HttpCode status={item.http_status} />
                      <span className="tabular text-muted">{formatMs(item.duration_ms)}</span>
                      <span className="tabular text-faint">{formatShortTime(item.created_at)}</span>
                    </span>
                  </div>
                }
              >
                <Link
                  role="listitem"
                  to={`/events/${item.event_id}`}
                  aria-label={label}
                  className="group absolute top-1/2 flex w-3 justify-center outline-none"
                  style={{
                    left: `${x * 100}%`,
                    height: dir === 'flat' ? 12 : h,
                    transform: `translate(-50%, ${dir === 'up' ? -h : dir === 'down' ? 0 : -6}px)`,
                  }}
                >
                  {dir === 'flat' ? (
                    <span className="mt-[3px] size-1.5 rounded-full border border-muted bg-surface" />
                  ) : (
                    <span
                      className={cn(
                        'w-[3px] rounded-full opacity-85 transition-[opacity,width] group-hover:w-1 group-hover:opacity-100 group-focus-visible:w-1 group-focus-visible:opacity-100 group-focus-visible:outline-2 group-focus-visible:outline-offset-2 group-focus-visible:outline-ring',
                        TICK_COLOR[item.status],
                      )}
                    />
                  )}
                </Link>
              </Tooltip>
            )
          })}
        </div>
      </div>
      <div className="mt-1 flex justify-between text-xs text-faint tabular" aria-hidden>
        <span>{edgeLabel(start, span)}</span>
        <span>now</span>
      </div>
    </div>
  )
}

export function WireLegend() {
  return (
    <ul className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted">
      <li className="flex items-center gap-1.5">
        <span aria-hidden className="h-3 w-[3px] -translate-y-1 rounded-full bg-chart-ok" /> Delivered, above the line
      </li>
      <li className="flex items-center gap-1.5">
        <span aria-hidden className="h-3 w-[3px] translate-y-1 rounded-full bg-chart-fail" /> Failed, below
      </li>
      <li className="flex items-center gap-1.5">
        <span aria-hidden className="flex items-end gap-[3px]">
          <span className="h-1.5 w-[3px] rounded-full bg-muted" />
          <span className="h-3 w-[3px] rounded-full bg-muted" />
        </span>
        Longer tick, slower response
      </li>
    </ul>
  )
}
