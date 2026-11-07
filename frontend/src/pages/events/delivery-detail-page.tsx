import { ArrowLeft, Hand, Zap } from 'lucide-react'
import { useState } from 'react'
import { Link, useParams } from 'react-router'
import { AttemptDetail } from '@/components/deliveries/attempt-detail'
import { AttemptTrace } from '@/components/events/attempt-trace'
import { MonoId } from '@/components/common/copy-button'
import { MetaList, Panel } from '@/components/common/page-header'
import { ErrorState } from '@/components/common/states'
import { HttpCode, StatusPill } from '@/components/common/status'
import { Skeleton } from '@/components/ui/skeleton'
import { useDelivery, useDeliveryAttempts } from '@/hooks/use-events'
import { useNow } from '@/hooks/use-now'
import { cn, formatDateTime, formatMs, formatRelative, shortId } from '@/lib/utils'

export default function DeliveryDetailPage() {
  const { id = '' } = useParams()
  const delivery = useDelivery(id)
  const live = !!delivery.data && !['delivered', 'failed'].includes(delivery.data.status)
  const attempts = useDeliveryAttempts(id, live)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  useNow(1000) // keeps "next retry" fresh

  if (delivery.isError) {
    return (
      <Panel>
        <ErrorState error={delivery.error} onRetry={() => delivery.refetch()} />
      </Panel>
    )
  }

  const d = delivery.data
  const list = [...(attempts.data?.items ?? [])].sort((a, b) => a.attempt_number - b.attempt_number)
  const selected = list.find((a) => a.id === selectedId) ?? list[list.length - 1]

  return (
    <>
      {d ? (
        <Link to={`/events/${d.event_id}`} className="mb-4 inline-flex items-center gap-1.5 text-sm text-muted hover:text-foreground">
          <ArrowLeft className="size-4" aria-hidden /> {d.event_type}
        </Link>
      ) : (
        <Skeleton className="mb-4 h-5 w-32" />
      )}

      {d ? (
        <div className="flex flex-wrap items-center gap-3 pb-6">
          <h1 className="display text-2xl font-semibold">
            Execution {d.execution_number}
            <span className="mono-tight ml-3 align-middle text-sm font-normal text-muted">{shortId(d.id, 'dlv_')}</span>
          </h1>
          <StatusPill status={d.status} />
        </div>
      ) : (
        <Skeleton className="mb-6 h-9 w-64" />
      )}

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_340px]">
        <div className="grid min-w-0 content-start gap-5">
          <Panel id="trace" title="Attempts" bodyClassName="px-4 py-4 sm:px-5">
            {d && !attempts.isPending ? (
              <AttemptTrace delivery={d} attempts={list} selectedId={selected?.id} onSelect={(a) => setSelectedId(a.id)} />
            ) : (
              <Skeleton className="h-20" />
            )}
          </Panel>

          {list.length > 0 && (
            <Panel id="history" title="Attempt history">
              <ol className="divide-y divide-border">
                {list.map((a) => (
                  <li key={a.id}>
                    <button
                      type="button"
                      onClick={() => setSelectedId(a.id)}
                      aria-current={selected?.id === a.id}
                      className={cn(
                        'grid w-full grid-cols-[3rem_4rem_1fr_auto] items-center gap-3 px-4 py-2.5 text-left text-base hover:bg-surface-hover sm:px-5',
                        selected?.id === a.id && 'bg-surface-hover',
                      )}
                    >
                      <span className="tabular text-muted">#{a.attempt_number}</span>
                      <HttpCode status={a.http_status} />
                      <span className="min-w-0 truncate text-sm text-muted">{a.error_message ?? formatMs(a.duration_ms)}</span>
                      <span className="tabular text-sm text-muted">{formatDateTime(a.attempted_at)}</span>
                    </button>
                  </li>
                ))}
              </ol>
            </Panel>
          )}

          {selected && (
            <Panel id="response" title={`Attempt ${selected.attempt_number} response`} bodyClassName="p-4 sm:p-5">
              <AttemptDetail attempt={selected} />
            </Panel>
          )}
        </div>

        <Panel id="delivery-meta" title="Delivery" className="self-start" bodyClassName="px-4 py-4 sm:px-5">
          {d ? (
            <MetaList
              className="grid-cols-[auto_minmax(0,1fr)] text-sm"
              items={[
                { label: 'Delivery ID', value: <MonoId value={d.id} display={shortId(d.id, 'dlv_')} /> },
                { label: 'Event', value: <Link to={`/events/${d.event_id}`} className="hover:text-primary">{d.event_type}</Link> },
                { label: 'Endpoint', value: <Link to={`/endpoints/${d.endpoint_id}`} className="hover:text-primary">{d.endpoint_name}</Link> },
                {
                  label: 'Trigger',
                  value: (
                    <span className="inline-flex items-center gap-1.5">
                      {d.trigger_type === 'manual' ? <Hand className="size-3.5" aria-hidden /> : <Zap className="size-3.5" aria-hidden />}
                      {d.trigger_type === 'manual' ? 'Manual replay' : 'Automatic'}
                    </span>
                  ),
                },
                { label: 'Attempts', value: <span className="tabular">{d.current_attempt} of {d.max_attempts}</span> },
                { label: 'Last response', value: <HttpCode status={d.last_http_status} /> },
                { label: 'Duration', value: formatMs(d.last_duration_ms) },
                {
                  label: 'Next retry',
                  value: d.next_attempt_at ? (
                    <span className="text-warning">{formatRelative(d.next_attempt_at)}</span>
                  ) : (
                    <span className="text-faint">None scheduled</span>
                  ),
                },
                { label: 'Started', value: formatDateTime(d.started_at) },
                { label: 'Completed', value: formatDateTime(d.completed_at) },
              ]}
            />
          ) : (
            <Skeleton className="h-56" />
          )}
        </Panel>
      </div>
    </>
  )
}
