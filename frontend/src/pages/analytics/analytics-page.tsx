import { useState, type ReactNode } from 'react'
import { Link } from 'react-router'
import { ChartLegend, LatencyChart, VolumeChart } from '@/components/dashboard/charts'
import { StatReadout } from '@/components/dashboard/stat-readout'
import { PageHeader, Panel } from '@/components/common/page-header'
import { ErrorState } from '@/components/common/states'
import { Segmented } from '@/components/ui/segmented'
import { Skeleton } from '@/components/ui/skeleton'
import { useAnalytics } from '@/hooks/use-analytics'
import { RANGE_OPTIONS, RANGE_TEXT } from '@/lib/constants'
import { cn, formatMs, formatNumber, formatPercent } from '@/lib/utils'
import type { FailureReason, TimeRange } from '@/types/api'

const REASON_LABEL: Record<FailureReason, string> = {
  http_5xx: 'Server errors (5xx)',
  http_4xx: 'Client errors (4xx)',
  http_3xx: 'Redirects (not followed)',
  http_429: 'Rate limited (429)',
  timeout: 'Timed out',
  connection: 'Connection failed',
}

/** Horizontal bars: one value per row, labelled directly. Single hue — rank isn't identity. */
function RankedBars({
  rows,
  empty,
}: {
  rows: { key: string; label: ReactNode; value: number; detail?: ReactNode }[]
  empty: string
}) {
  if (rows.length === 0) return <p className="px-5 py-8 text-center text-sm text-muted">{empty}</p>
  const max = Math.max(...rows.map((r) => r.value), 1)
  return (
    <ul className="grid gap-3.5 px-4 py-4 sm:px-5">
      {rows.map((r) => (
        <li key={r.key} className="grid gap-1.5">
          <div className="flex items-baseline justify-between gap-3 text-sm">
            <span className="min-w-0 truncate">{r.label}</span>
            <span className="tabular shrink-0 text-muted">
              {formatNumber(r.value)}
              {r.detail}
            </span>
          </div>
          <div className="h-1.5 rounded-full bg-sunken" aria-hidden>
            <div className="h-full rounded-full bg-chart-1" style={{ width: `${(r.value / max) * 100}%` }} />
          </div>
        </li>
      ))}
    </ul>
  )
}

export default function AnalyticsPage() {
  const [range, setRange] = useState<TimeRange>('7d')
  const { data, isPending, isError, error, refetch, isPlaceholderData } = useAnalytics(range)

  return (
    <>
      <PageHeader
        title="Analytics"
        description={`Delivery health across all endpoints, ${RANGE_TEXT[range]}.`}
        actions={<Segmented label="Time range" value={range} onValueChange={setRange} options={RANGE_OPTIONS} />}
      />

      {isError ? (
        <Panel>
          <ErrorState error={error} onRetry={() => refetch()} />
        </Panel>
      ) : (
        <div className={cn('grid gap-5', isPlaceholderData && 'opacity-70 transition-opacity')}>
          <StatReadout
            loading={isPending}
            items={[
              { label: 'Events', value: formatNumber(data?.total_events) },
              { label: 'Success rate', value: formatPercent(data?.success_rate) },
              { label: 'Average latency', value: formatMs(data?.avg_latency_ms) },
              { label: 'p95 latency', value: formatMs(data?.p95_latency_ms) },
              {
                label: 'Failed attempts',
                value: formatNumber(data?.failure_distribution.reduce((s, f) => s + f.count, 0)),
              },
            ]}
          />

          <Panel
            id="volume"
            title="Event volume"
            actions={
              <ChartLegend
                items={[
                  { label: 'Delivered', swatch: 'var(--chart-ok)' },
                  { label: 'Failed', swatch: 'var(--chart-fail)' },
                ]}
              />
            }
            bodyClassName="px-2 pt-4 pb-2 sm:px-3"
          >
            {isPending ? <Skeleton className="mx-2 h-72" /> : <VolumeChart series={data.series} range={range} height={280} />}
          </Panel>

          <div className="grid gap-5 lg:grid-cols-2">
            <Panel
              id="latency"
              title="Response latency"
              actions={
                <ChartLegend
                  items={[
                    { label: 'Average', swatch: 'var(--chart-1)', shape: 'line' },
                    { label: 'p95', swatch: 'var(--chart-2)', shape: 'dash' },
                  ]}
                />
              }
              bodyClassName="px-2 pt-4 pb-2 sm:px-3"
            >
              {isPending ? <Skeleton className="mx-2 h-60" /> : <LatencyChart series={data.series} range={range} />}
            </Panel>
            <Panel id="failures" title="Why attempts failed" description="Failed attempts by cause, including ones later retried successfully.">
              {isPending ? (
                <Skeleton className="m-5 h-40" />
              ) : (
                <RankedBars
                  empty="No failed attempts in this period."
                  rows={[...data.failure_distribution]
                    .sort((a, b) => b.count - a.count)
                    .map((f) => ({ key: f.reason, label: REASON_LABEL[f.reason] ?? f.reason, value: f.count }))}
                />
              )}
            </Panel>
          </div>

          <div className="grid gap-5 lg:grid-cols-2">
            <Panel id="top-endpoints" title="Most active endpoints">
              {isPending ? (
                <Skeleton className="m-5 h-40" />
              ) : (
                <RankedBars
                  empty="No events in this period."
                  rows={data.top_endpoints.map((e) => ({
                    key: e.endpoint_id,
                    label: (
                      <Link to={`/endpoints/${e.endpoint_id}`} className="hover:text-primary">
                        {e.name}
                      </Link>
                    ),
                    value: e.total,
                    detail: <span className="ml-2 text-faint">{formatPercent(e.success_rate)} ok</span>,
                  }))}
                />
              )}
            </Panel>
            <Panel id="failed-types" title="Event types that fail most">
              {isPending ? (
                <Skeleton className="m-5 h-40" />
              ) : (
                <RankedBars
                  empty="Nothing failed in this period."
                  rows={data.top_failed_event_types.map((t) => ({
                    key: t.event_type,
                    label: (
                      <Link to={`/events?status=failed&search=${encodeURIComponent(t.event_type)}`} className="hover:text-primary">
                        <code className="mono-tight">{t.event_type}</code>
                      </Link>
                    ),
                    value: t.count,
                  }))}
                />
              )}
            </Panel>
          </div>
        </div>
      )}
    </>
  )
}
