import { MoreHorizontal, Pencil, Plus, Radio, RefreshCcw, Send, Trash2 } from 'lucide-react'
import { useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router'
import { EndpointActionDialogs, type EndpointAction } from '@/components/endpoints/endpoint-actions'
import { useSendTestWithToast } from '@/hooks/use-send-test'
import { EndpointFormDialog } from '@/components/endpoints/endpoint-form-dialog'
import { CopyButton } from '@/components/common/copy-button'
import { PageHeader, Panel } from '@/components/common/page-header'
import { EmptyState, ErrorState } from '@/components/common/states'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { useEndpoints, useUpdateEndpoint } from '@/hooks/use-endpoints'
import { cn, formatNumber, formatPercent, formatRelative } from '@/lib/utils'
import type { Endpoint } from '@/types/api'

function SuccessRate({ rate }: { rate: number | null | undefined }) {
  if (rate == null) return <span className="text-faint">—</span>
  const tone = rate >= 0.98 ? 'text-success' : rate >= 0.9 ? 'text-warning' : 'text-danger'
  return <span className={cn('tabular font-medium', tone)}>{formatPercent(rate)}</span>
}

function EndpointMenu({ endpoint, onAction }: { endpoint: Endpoint; onAction: (a: EndpointAction, e: Endpoint) => void }) {
  const test = useSendTestWithToast()
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon-sm" aria-label={`Actions for ${endpoint.name}`}>
          <MoreHorizontal />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent>
        <DropdownMenuItem disabled={!endpoint.enabled} onSelect={() => test.run(endpoint)}>
          <Send /> Send test event
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => onAction('edit', endpoint)}>
          <Pencil /> Edit
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => onAction('rotate', endpoint)}>
          <RefreshCcw /> Rotate signing secret
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem tone="danger" onSelect={() => onAction('delete', endpoint)}>
          <Trash2 /> Delete
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function EnabledSwitch({ endpoint }: { endpoint: Endpoint }) {
  const update = useUpdateEndpoint()
  return (
    <Switch
      checked={endpoint.enabled}
      onCheckedChange={(enabled) => update.mutate({ id: endpoint.id, body: { enabled } })}
      aria-label={`${endpoint.enabled ? 'Disable' : 'Enable'} ${endpoint.name}`}
    />
  )
}

export default function EndpointsPage() {
  const [params, setParams] = useSearchParams()
  const { data, isPending, isError, error, refetch } = useEndpoints()
  const [query, setQuery] = useState('')
  const [action, setAction] = useState<EndpointAction>(null)
  const [target, setTarget] = useState<Endpoint | null>(null)
  const creating = params.get('new') === '1'

  const setCreating = (open: boolean) => {
    const next = new URLSearchParams(params)
    if (open) next.set('new', '1')
    else next.delete('new')
    setParams(next, { replace: true })
  }

  const onAction = (a: EndpointAction, e: Endpoint) => {
    setTarget(e)
    setAction(a)
  }

  const endpoints = useMemo(() => {
    const items = data?.items ?? []
    const q = query.trim().toLowerCase()
    return q ? items.filter((e) => e.name.toLowerCase().includes(q) || e.url.toLowerCase().includes(q)) : items
  }, [data, query])

  const total = data?.items.length ?? 0

  return (
    <>
      <PageHeader
        title="Endpoints"
        description="URLs that receive your events. Each one has its own signing secret."
        actions={
          <Button variant="primary" onClick={() => setCreating(true)}>
            <Plus /> Add endpoint
          </Button>
        }
      />

      <Panel
        title={total ? `${total} endpoint${total === 1 ? '' : 's'}` : 'Endpoints'}
        actions={
          total > 4 ? (
            <Input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Filter by name or URL"
              aria-label="Filter endpoints"
              className="h-8 w-56 text-sm"
            />
          ) : null
        }
      >
        {isPending ? (
          <div className="grid gap-3 p-5">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-10" />
            ))}
          </div>
        ) : isError ? (
          <ErrorState error={error} onRetry={() => refetch()} />
        ) : total === 0 ? (
          <EmptyState
            icon={<Radio />}
            title="Add your first endpoint"
            description="Give Heimdall a URL on your server. You’ll get a signing secret your code can use to check that requests really came from us."
            action={
              <Button variant="primary" onClick={() => setCreating(true)}>
                <Plus /> Add endpoint
              </Button>
            }
          />
        ) : endpoints.length === 0 ? (
          <p className="px-5 py-10 text-center text-muted">No endpoints match “{query}”.</p>
        ) : (
          <>
            {/* desktop */}
            <div className="hidden overflow-x-auto lg:block">
              <table className="w-full text-base">
                <thead>
                  <tr className="border-b border-border text-left text-sm text-muted">
                    <th scope="col" className="px-5 py-2.5 font-medium">Name</th>
                    <th scope="col" className="px-3 py-2.5 font-medium">URL</th>
                    <th scope="col" className="px-3 py-2.5 font-medium">Active</th>
                    <th scope="col" className="px-3 py-2.5 text-right font-medium">Events</th>
                    <th scope="col" className="px-3 py-2.5 text-right font-medium">Success</th>
                    <th scope="col" className="px-3 py-2.5 text-right font-medium">Last event</th>
                    <th scope="col" className="w-12 px-3 py-2.5"><span className="sr-only">Actions</span></th>
                  </tr>
                </thead>
                <tbody>
                  {endpoints.map((e) => (
                    <tr key={e.id} className={cn('border-b border-border last:border-0 hover:bg-surface-hover/60', !e.enabled && 'text-muted')}>
                      <td className="px-5 py-3">
                        <Link to={`/endpoints/${e.id}`} className="font-medium text-foreground hover:text-primary">
                          {e.name}
                        </Link>
                        {e.description && <p className="max-w-64 truncate text-sm text-muted">{e.description}</p>}
                      </td>
                      <td className="px-3 py-3">
                        <span className="flex max-w-56 items-center gap-0.5 2xl:max-w-80">
                          <code className="mono-tight truncate text-sm text-muted" title={e.url}>
                            {e.url.replace(/^https?:\/\//, '')}
                          </code>
                          <CopyButton value={e.url} label={`Copy URL for ${e.name}`} className="size-7 text-faint" />
                        </span>
                      </td>
                      <td className="px-3 py-3">
                        <EnabledSwitch endpoint={e} />
                      </td>
                      <td className="tabular px-3 py-3 text-right">{formatNumber(e.stats?.total_events)}</td>
                      <td className="px-3 py-3 text-right">
                        <SuccessRate rate={e.stats?.success_rate} />
                      </td>
                      <td className="tabular px-3 py-3 text-right whitespace-nowrap text-muted">{formatRelative(e.stats?.last_event_at)}</td>
                      <td className="px-3 py-3 text-right">
                        <EndpointMenu endpoint={e} onAction={onAction} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* mobile & tablet */}
            <ul className="divide-y divide-border lg:hidden">
              {endpoints.map((e) => (
                <li key={e.id} className="grid grid-cols-[minmax(0,1fr)] gap-2.5 px-4 py-3.5">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <Link to={`/endpoints/${e.id}`} className="font-medium hover:text-primary">
                        {e.name}
                      </Link>
                      <code className="mono-tight block truncate text-sm text-muted">{e.url.replace(/^https?:\/\//, '')}</code>
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                      <EnabledSwitch endpoint={e} />
                      <EndpointMenu endpoint={e} onAction={onAction} />
                    </div>
                  </div>
                  <dl className="flex gap-5 text-sm">
                    <div>
                      <dt className="text-faint">Events</dt>
                      <dd className="tabular">{formatNumber(e.stats?.total_events)}</dd>
                    </div>
                    <div>
                      <dt className="text-faint">Success</dt>
                      <dd>
                        <SuccessRate rate={e.stats?.success_rate} />
                      </dd>
                    </div>
                    <div>
                      <dt className="text-faint">Last event</dt>
                      <dd className="tabular text-muted">{formatRelative(e.stats?.last_event_at)}</dd>
                    </div>
                  </dl>
                </li>
              ))}
            </ul>
          </>
        )}
      </Panel>

      <EndpointFormDialog open={creating} onOpenChange={setCreating} />
      <EndpointActionDialogs endpoint={target} action={action} onClose={() => setAction(null)} />
    </>
  )
}
