import { ArrowUpRight, Radio, Send } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router'
import { ChartLegend, LatencyChart, VolumeChart } from '@/components/dashboard/charts'
import { DeliveryWire, WireLegend } from '@/components/dashboard/delivery-wire'
import { RateMeter, StatReadout } from '@/components/dashboard/stat-readout'
import { ActivityTable } from '@/components/events/activity-table'
import { PageHeader, Panel } from '@/components/common/page-header'
import { EmptyState, ErrorState } from '@/components/common/states'
import { Button } from '@/components/ui/button'
import { Segmented } from '@/components/ui/segmented'
import { Skeleton } from '@/components/ui/skeleton'
import { useAuth } from '@/contexts/auth-context'
import { useDashboardActivity, useDashboardStats } from '@/hooks/use-analytics'
import { RANGE_OPTIONS, RANGE_TEXT } from '@/lib/constants'
import { formatMs, formatNumber, formatPercent, formatRelative } from '@/lib/utils'
import type { TimeRange } from '@/types/api'

export default function DashboardPage() {
  const [range, setRange] = useState<TimeRange>('24h')
  const { user } = useAuth()
  const isDemo = user?.is_demo ?? false
  const stats = useDashboardStats(range)
  const activity = useDashboardActivity()

  const s = stats.data
  const items = activity.data?.items ?? []
  const noData = s && s.total_events === 0 && items.length === 0

  return (
    <>
      <PageHeader
        title="Overview"
        description={`How your webhooks performed over the ${RANGE_TEXT[range]}.`}
        actions={<Segmented label="Time range" value={range} onValueChange={setRange} options={RANGE_OPTIONS} />}
      />

      {isDemo && <DemoNotice expiresAt={user?.demo_expires_at} />}

      {stats.isError ? (
        <Panel>
          <ErrorState error={stats.error} onRetry={() => stats.refetch()} />
        </Panel>
      ) : noData ? (
        <Panel>
          <EmptyState
            icon={<Radio />}
            title="No events yet"
            description="Add an endpoint, then send an event to it with your API key or the test button. Deliveries show up here as they happen."
            action={
              <div className="flex flex-wrap justify-center gap-2">
                <Button asChild variant="primary">
                  <Link to="/endpoints?new=1">Add an endpoint</Link>
                </Button>
                <Button asChild variant="secondary">
                  <Link to="/settings/api-keys">
                    <Send /> Get an API key
                  </Link>
                </Button>
              </div>
            }
          />
        </Panel>
      ) : (
        <div className="grid gap-5">
          <Panel
            id="wire"
            title="Live deliveries"
            description="Each tick is one delivery. Select a tick to open the event."
            actions={<WireLegend />}
            bodyClassName="px-4 pt-4 pb-3 sm:px-5"
          >
            {activity.isPending ? (
              <Skeleton className="h-32 w-full" />
            ) : activity.isError ? (
              <ErrorState error={activity.error} onRetry={() => activity.refetch()} className="py-6" />
            ) : items.length === 0 ? (
              <p className="py-10 text-center text-base text-muted">Nothing delivered recently.</p>
            ) : (
              <DeliveryWire items={items} />
            )}
          </Panel>

          <StatReadout
            loading={stats.isPending}
            items={[
              { label: 'Events received', value: formatNumber(s?.total_events) },
              { label: 'Delivered', value: formatNumber(s?.successful_deliveries) },
              {
                label: 'Failed',
                value: formatNumber(s?.failed_deliveries),
                tone: s && s.failed_deliveries > 0 ? 'danger' : 'default',
                detail:
                  s && s.failed_deliveries > 0 ? (
                    <Link to="/events?status=failed" className="inline-flex items-center gap-0.5 text-primary hover:underline">
                      Review failures <ArrowUpRight className="size-3.5" aria-hidden />
                    </Link>
                  ) : (
                    'All retries succeeded'
                  ),
              },
              {
                label: 'Success rate',
                value: formatPercent(s?.success_rate),
                detail: <RateMeter ratio={s?.success_rate ?? null} label="Success rate" />,
              },
              { label: 'Avg. response time', value: formatMs(s?.avg_response_ms) },
            ]}
          />

          <div className="grid gap-5 xl:grid-cols-5">
            <Panel
              id="volume"
              title="Event volume"
              className="xl:col-span-3"
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
              {stats.isPending ? <Skeleton className="mx-2 h-60" /> : <VolumeChart series={s?.series ?? []} range={range} />}
            </Panel>
            <Panel
              id="latency"
              title="Response time"
              className="xl:col-span-2"
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
              {stats.isPending ? <Skeleton className="mx-2 h-60" /> : <LatencyChart series={s?.series ?? []} range={range} />}
            </Panel>
          </div>

          <Panel
            id="recent"
            title="Recent activity"
            actions={
              <Button asChild variant="ghost" size="sm">
                <Link to="/events">View all events</Link>
              </Button>
            }
          >
            <ActivityTable items={items.slice(0, 10)} loading={activity.isPending} />
          </Panel>
        </div>
      )}
    </>
  )
}

/** The shared demo account: say what's sample data and what's real (plan §14.3). */
function DemoNotice({ expiresAt }: { expiresAt?: string | null }) {
  return (
    <div className="mb-5 flex flex-col gap-3 rounded-lg border border-dashed border-border-strong px-4 py-3.5 sm:flex-row sm:items-center sm:justify-between sm:px-5">
      <p className="max-w-[72ch] text-sm text-muted">
        <span className="font-medium text-foreground">This is your own copy of the demo.</span> Events marked{' '}
        <span className="rounded-sm border border-dashed border-border-strong px-1 text-xs">Sample</span> are seeded
        history with simulated attempts. Change anything you like: test events and replays are delivered for real to a
        built-in test receiver. Nobody else sees your copy, and it’s deleted when you sign out
        {expiresAt ? `, or ${formatRelative(expiresAt)}` : ''}.
      </p>
      <Button asChild variant="secondary" size="sm" className="shrink-0">
        <Link to="/endpoints">Send a test event</Link>
      </Button>
    </div>
  )
}
