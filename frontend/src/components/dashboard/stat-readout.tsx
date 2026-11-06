import type { ReactNode } from 'react'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'

export interface Readout {
  label: string
  value: ReactNode
  detail?: ReactNode
  tone?: 'default' | 'success' | 'danger'
}

/**
 * Key figures as a single instrument band rather than a row of cards.
 * Cells share borders; the band wraps to two columns on narrow screens.
 */
export function StatReadout({ items, loading }: { items: Readout[]; loading?: boolean }) {
  return (
    <dl className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-border bg-border sm:grid-cols-3 xl:grid-cols-5">
      {items.map((item, i) => (
        <div
          key={item.label}
          className={cn(
            'min-w-0 bg-surface px-4 py-4 sm:px-5',
            i === items.length - 1 && 'col-span-2 xl:col-span-1',
          )}
        >
          <dt className="text-sm text-muted">{item.label}</dt>
          <dd className="mt-1.5">
            {loading ? (
              <Skeleton className="h-8 w-24" />
            ) : (
              <span
                className={cn(
                  'display tabular text-2xl font-semibold',
                  item.tone === 'success' && 'text-success',
                  item.tone === 'danger' && 'text-danger',
                )}
              >
                {item.value}
              </span>
            )}
            {item.detail && !loading && <div className="mt-1.5 text-sm text-muted">{item.detail}</div>}
          </dd>
        </div>
      ))}
    </dl>
  )
}

/** Thin proportion meter for success rate. */
export function RateMeter({ ratio, label }: { ratio: number | null; label: string }) {
  const pct = ratio == null ? 0 : Math.round(ratio * 1000) / 10
  return (
    <div
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={pct}
      className="flex h-1.5 w-full max-w-36 overflow-hidden rounded-full bg-chart-fail/70"
    >
      <span className="h-full rounded-full bg-chart-ok" style={{ width: `${ratio == null ? 0 : pct}%` }} />
      {ratio == null && <span className="h-full w-full bg-border" />}
    </div>
  )
}
