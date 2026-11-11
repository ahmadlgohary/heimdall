import { ArrowLeft, RotateCcw } from 'lucide-react'
import { useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router'
import { toast } from 'sonner'
import { ExecutionBlock } from '@/components/events/execution-block'
import { MonoId, CopyButton } from '@/components/common/copy-button'
import { JsonViewer } from '@/components/common/json-viewer'
import { MetaList, Panel } from '@/components/common/page-header'
import { ErrorState } from '@/components/common/states'
import { SampleTag } from '@/components/common/sample-tag'
import { StatusPill } from '@/components/common/status'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/dialog'
import { Skeleton } from '@/components/ui/skeleton'
import { useEvent, useEventDeliveries, useEventPayload, useReplayEvent } from '@/hooks/use-events'
import { useReadOnly } from '@/hooks/use-read-only'
import { errorMessage } from '@/lib/api-client'
import { queryKeys } from '@/lib/query-client'
import { formatBytes, formatDateTime, formatRelative, shortId } from '@/lib/utils'

export default function EventDetailPage() {
  const readOnly = useReadOnly()
  const { id = '' } = useParams()
  const event = useEvent(id)
  const live = !!event.data && !['delivered', 'failed'].includes(event.data.status)
  const deliveries = useEventDeliveries(id, live)
  const queryClient = useQueryClient()
  // when the event settles, pull the final delivery state once more
  const eventStatus = event.data?.status
  useEffect(() => {
    if (eventStatus && !live) void queryClient.invalidateQueries({ queryKey: queryKeys.eventDeliveries(id) })
  }, [eventStatus, live, id, queryClient])
  const payload = useEventPayload(id)
  const replay = useReplayEvent(id)
  const [confirming, setConfirming] = useState(false)

  if (event.isError) {
    return (
      <>
        <BackLink />
        <Panel>
          <ErrorState error={event.error} onRetry={() => event.refetch()} />
        </Panel>
      </>
    )
  }

  const e = event.data
  // newest execution first
  const executions = [...(deliveries.data?.items ?? [])].sort((a, b) => b.execution_number - a.execution_number)

  return (
    <>
      <BackLink />

      {!e ? (
        <div className="grid gap-3 pb-6">
          <Skeleton className="h-9 w-72" />
          <Skeleton className="h-5 w-48" />
        </div>
      ) : (
        <div className="flex flex-col gap-4 pb-6 sm:flex-row sm:items-end sm:justify-between">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-3">
              <h1 className="display text-2xl font-semibold break-all sm:text-3xl">{e.event_type}</h1>
              <StatusPill status={e.status} />
            </div>
            <p className="mt-1.5 flex flex-wrap items-center gap-x-2 text-base text-muted">
              <span className="inline-flex items-center">
                <code className="mono-tight text-sm text-foreground/80" title={e.id}>
                  {shortId(e.id, 'evt_')}
                </code>
                <CopyButton value={e.id} label="Copy event ID" className="size-7 text-faint" />
              </span>
              <span>
                sent to{' '}
                <Link to={`/endpoints/${e.endpoint_id}`} className="text-foreground hover:text-primary">
                  {e.endpoint_name}
                </Link>{' '}
                {formatRelative(e.created_at)}
              </span>
            </p>
          </div>
          <div className="flex flex-col items-start gap-1.5 sm:items-end">
            <Button variant="primary" onClick={() => setConfirming(true)} disabled={readOnly || !e.endpoint_enabled || live}>
              <RotateCcw /> Replay event
            </Button>
            {readOnly ? (
              <p className="text-sm text-muted">Replays are off in the read-only demo.</p>
            ) : !e.endpoint_enabled ? (
              <p className="text-sm text-muted">Enable the endpoint to replay.</p>
            ) : live ? (
              <p className="text-sm text-muted">Available once delivery finishes.</p>
            ) : null}
          </div>
        </div>
      )}

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_340px]">
        <div className="grid min-w-0 content-start gap-5">
          <Panel
            id="deliveries"
            title="Delivery"
            description={live ? 'Updating live while delivery is in progress.' : 'Select an attempt to see the response.'}
          >
            {e?.source === 'demo_fixture' && (
              <p className="flex items-start gap-2.5 border-b border-dashed border-border-strong bg-sunken/50 px-4 py-3 text-sm text-muted sm:px-5">
                <SampleTag className="mt-px" />
                <span>
                  This event is sample data from the demo seed. Its delivery attempts were simulated and never sent.
                </span>
              </p>
            )}
            {deliveries.isPending ? (
              <div className="p-5">
                <Skeleton className="h-28" />
              </div>
            ) : deliveries.isError ? (
              <ErrorState error={deliveries.error} onRetry={() => deliveries.refetch()} />
            ) : executions.length === 0 ? (
              <p className="px-5 py-8 text-center text-muted">Queued. The first delivery attempt starts shortly.</p>
            ) : (
              executions.map((d, i) => <ExecutionBlock key={d.id} delivery={d} defaultOpen={i === 0} />)
            )}
          </Panel>

          <Panel id="payload" title="Payload" description="The exact JSON body sent to your endpoint." bodyClassName="p-3 sm:p-4">
            {payload.isPending ? (
              <Skeleton className="h-48" />
            ) : payload.isError ? (
              <ErrorState error={payload.error} onRetry={() => payload.refetch()} className="py-8" />
            ) : (
              <JsonViewer value={payload.data} title="Event payload" />
            )}
          </Panel>
        </div>

        <div className="grid content-start gap-5">
          <Panel id="meta" title="Event" bodyClassName="px-4 py-4 sm:px-5">
            {e ? (
              <MetaList
                className="grid-cols-[auto_minmax(0,1fr)] text-sm"
                items={[
                  { label: 'Event ID', value: <MonoId value={e.id} display={shortId(e.id, 'evt_')} /> },
                  { label: 'Type', value: <code className="mono-tight">{e.event_type}</code> },
                  { label: 'Received', value: formatDateTime(e.created_at) },
                  { label: 'Payload', value: formatBytes(e.payload_size) },
                  {
                    label: 'Idempotency key',
                    value: e.idempotency_key ? (
                      <MonoId value={e.idempotency_key} />
                    ) : (
                      <span className="text-faint">None</span>
                    ),
                  },
                  { label: 'Attempts', value: <span className="tabular">{e.attempts}</span> },
                ]}
              />
            ) : (
              <Skeleton className="h-40" />
            )}
          </Panel>
          <Panel id="destination" title="Destination" bodyClassName="px-4 py-4 sm:px-5">
            {e ? (
              <div className="grid gap-3 text-sm">
                <Link to={`/endpoints/${e.endpoint_id}`} className="font-medium hover:text-primary">
                  {e.endpoint_name}
                </Link>
                <div className="flex items-start gap-1 rounded-md border border-border bg-sunken py-1 pr-1 pl-3">
                  <code className="mono-tight min-w-0 flex-1 py-1.5 text-sm break-all">{e.endpoint_url}</code>
                  <CopyButton value={e.endpoint_url} label="Copy destination URL" />
                </div>
                {!e.endpoint_enabled && <p className="text-warning">This endpoint is disabled.</p>}
              </div>
            ) : (
              <Skeleton className="h-20" />
            )}
          </Panel>
        </div>
      </div>

      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        tone="primary"
        title="Replay this event?"
        description={
          <>
            Heimdall sends the original payload to <strong className="text-foreground">{e?.endpoint_name}</strong> again as
            a new execution, with the same event ID. Earlier attempts stay in the history.
          </>
        }
        confirmLabel="Replay event"
        loading={replay.isPending}
        onConfirm={async () => {
          try {
            await replay.mutateAsync()
            toast.success('Replay queued')
            setConfirming(false)
          } catch (err) {
            toast.error(errorMessage(err))
          }
        }}
      />
    </>
  )
}

function BackLink() {
  return (
    <Link to="/events" className="mb-4 inline-flex items-center gap-1.5 text-sm text-muted hover:text-foreground">
      <ArrowLeft className="size-4" aria-hidden /> Events
    </Link>
  )
}
