import { ArrowLeft, Pencil, RefreshCcw, Send, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import { EndpointActionDialogs, type EndpointAction } from '@/components/endpoints/endpoint-actions'
import { useSendTestWithToast } from '@/hooks/use-send-test'
import { VerifySnippet } from '@/components/endpoints/verify-snippet'
import { EventsTable } from '@/components/events/events-table'
import { CopyButton, MonoId } from '@/components/common/copy-button'
import { MetaList, Panel } from '@/components/common/page-header'
import { ErrorState } from '@/components/common/states'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { useEndpoint, useUpdateEndpoint } from '@/hooks/use-endpoints'
import { useEvents } from '@/hooks/use-events'
import { formatDateTime, formatNumber, formatPercent, formatRelative, shortId } from '@/lib/utils'

export default function EndpointDetailPage() {
  const { id = '' } = useParams()
  const navigate = useNavigate()
  const { data: endpoint, isPending, isError, error, refetch } = useEndpoint(id)
  const events = useEvents({ endpoint_id: id, limit: 10, page: 1 })
  const update = useUpdateEndpoint()
  const test = useSendTestWithToast()
  const [action, setAction] = useState<EndpointAction>(null)

  if (isError) {
    return (
      <Panel>
        <ErrorState error={error} onRetry={() => refetch()} />
      </Panel>
    )
  }

  return (
    <>
      <Link to="/endpoints" className="mb-4 inline-flex items-center gap-1.5 text-sm text-muted hover:text-foreground">
        <ArrowLeft className="size-4" aria-hidden /> Endpoints
      </Link>

      {isPending ? (
        <div className="grid gap-3 pb-6">
          <Skeleton className="h-8 w-64" />
          <Skeleton className="h-5 w-96 max-w-full" />
        </div>
      ) : (
        <div className="flex flex-col gap-4 pb-6 xl:flex-row xl:items-end xl:justify-between">
          <div className="min-w-0">
            <div className="flex items-center gap-3">
              <h1 className="display truncate text-2xl font-semibold">{endpoint.name}</h1>
              <span className={endpoint.enabled ? 'text-sm text-success' : 'text-sm text-muted'}>
                {endpoint.enabled ? 'Active' : 'Disabled'}
              </span>
            </div>
            <div className="mt-1 flex min-w-0 items-center gap-0.5">
              <code className="mono-tight truncate text-sm text-muted">{endpoint.url}</code>
              <CopyButton value={endpoint.url} label="Copy URL" className="size-7 text-faint" />
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <label className="mr-2 flex items-center gap-2.5 text-sm text-muted">
              <Switch
                checked={endpoint.enabled}
                onCheckedChange={(enabled) => update.mutate({ id, body: { enabled } })}
                aria-label="Deliver events"
              />
              Deliver events
            </label>
            <Button variant="primary" disabled={!endpoint.enabled} loading={test.pending} onClick={() => test.run(endpoint)}>
              <Send /> Send test event
            </Button>
            <Button variant="secondary" onClick={() => setAction('edit')}>
              <Pencil /> Edit
            </Button>
            <Button variant="secondary" onClick={() => setAction('rotate')}>
              <RefreshCcw /> Rotate secret
            </Button>
            <Button variant="danger-ghost" size="icon" aria-label="Delete endpoint" onClick={() => setAction('delete')}>
              <Trash2 />
            </Button>
          </div>
        </div>
      )}

      <div className="grid gap-5 xl:grid-cols-3">
        <div className="grid min-w-0 content-start gap-5 xl:col-span-2">
          <Panel
            id="recent-events"
            title="Recent events"
            actions={
              <Button asChild variant="ghost" size="sm">
                <Link to={`/events?endpoint_id=${id}`}>View all</Link>
              </Button>
            }
          >
            {events.isError ? (
              <ErrorState error={events.error} onRetry={() => events.refetch()} />
            ) : !events.isPending && events.data?.items.length === 0 ? (
              <p className="px-5 py-10 text-center text-muted">
                No events yet. Send a test event, or POST to <code className="mono-tight text-sm">/api/v1/ingest/{id.slice(0, 8)}…</code>
              </p>
            ) : (
              <EventsTable events={events.data?.items ?? []} loading={events.isPending} hideEndpoint />
            )}
          </Panel>
          <Panel id="verify" title="Verify signatures" description="Check every request in your receiver before trusting it.">
            <VerifySnippet />
          </Panel>
        </div>

        <Panel id="details" title="Details" className="self-start" bodyClassName="px-4 py-4 sm:px-5">
          {endpoint ? (
            <MetaList
              className="grid-cols-[auto_minmax(0,1fr)] text-sm"
              items={[
                { label: 'Endpoint ID', value: <MonoId value={endpoint.id} display={shortId(endpoint.id, 'ep_')} /> },
                { label: 'Description', value: endpoint.description || <span className="text-faint">None</span> },
                { label: 'Events', value: <span className="tabular">{formatNumber(endpoint.stats?.total_events)}</span> },
                { label: 'Success rate', value: <span className="tabular">{formatPercent(endpoint.stats?.success_rate)}</span> },
                { label: 'Last event', value: formatRelative(endpoint.stats?.last_event_at) },
                { label: 'Created', value: formatDateTime(endpoint.created_at) },
                { label: 'Updated', value: formatDateTime(endpoint.updated_at) },
              ]}
            />
          ) : (
            <Skeleton className="h-40" />
          )}
        </Panel>
      </div>

      <EndpointActionDialogs
        endpoint={endpoint ?? null}
        action={action}
        onClose={() => setAction(null)}
        afterDelete={() => navigate('/endpoints', { replace: true })}
      />
    </>
  )
}
