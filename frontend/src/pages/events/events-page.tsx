import { Activity, Download, Search, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useSearchParams } from 'react-router'
import { EventsTable } from '@/components/events/events-table'
import { PageHeader, Panel } from '@/components/common/page-header'
import { Pagination } from '@/components/common/pagination'
import { EmptyState, ErrorState } from '@/components/common/states'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { useEndpoints } from '@/hooks/use-endpoints'
import { useEvents } from '@/hooks/use-events'
import { STATUS_OPTIONS } from '@/lib/constants'
import { downloadFile, toCsv } from '@/lib/utils'
import type { EventFilters, EventStatus } from '@/types/api'

const PAGE_SIZE = 20

/** Filters live in the URL so a filtered view can be shared or bookmarked. */
function useEventFilters() {
  const [params, setParams] = useSearchParams()
  const filters: EventFilters = {
    page: Number(params.get('page') ?? 1) || 1,
    limit: PAGE_SIZE,
    search: params.get('search') ?? '',
    status: (params.get('status') ?? '') as EventStatus | '',
    endpoint_id: params.get('endpoint_id') ?? '',
    from: params.get('from') ?? '',
    to: params.get('to') ?? '',
    sort: params.get('sort') === 'created_at' ? 'created_at' : '-created_at',
  }
  const update = (patch: Partial<EventFilters>) => {
    const next = new URLSearchParams(params)
    const resetPage = !('page' in patch)
    for (const [k, v] of Object.entries(patch)) {
      if (v === '' || v == null || (k === 'page' && v === 1) || (k === 'sort' && v === '-created_at')) next.delete(k)
      else next.set(k, String(v))
    }
    if (resetPage) next.delete('page')
    setParams(next, { replace: true })
  }
  return [filters, update] as const
}

/** Date inputs give a local day; the API wants an ISO instant. */
function dayBoundary(day: string, end: boolean) {
  if (!day) return ''
  const d = new Date(`${day}T${end ? '23:59:59.999' : '00:00:00'}`)
  return Number.isNaN(d.getTime()) ? '' : d.toISOString()
}

export default function EventsPage() {
  const [filters, setFilters] = useEventFilters()
  const [search, setSearch] = useState(filters.search ?? '')
  const endpoints = useEndpoints()

  // keep the box in sync when the header search navigates here
  const [lastUrlSearch, setLastUrlSearch] = useState(filters.search)
  if (lastUrlSearch !== filters.search) {
    setLastUrlSearch(filters.search)
    setSearch(filters.search ?? '')
  }

  // debounce typing into the URL
  useEffect(() => {
    if (search === (filters.search ?? '')) return
    const t = setTimeout(() => setFilters({ search: search.trim() }), 300)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search])

  const query = useEvents({ ...filters, from: dayBoundary(filters.from ?? '', false), to: dayBoundary(filters.to ?? '', true) })
  const { data, isPending, isError, error, refetch, isPlaceholderData } = query

  const active = !!(filters.search || filters.status || filters.endpoint_id || filters.from || filters.to)
  const endpointOptions = [
    { value: '', label: 'All endpoints' },
    ...(endpoints.data?.items ?? []).map((e) => ({ value: e.id, label: e.name })),
  ]

  const exportCsv = () => {
    if (!data) return
    const rows = data.items.map((e) => ({
      id: e.id,
      event_type: e.event_type,
      endpoint: e.endpoint_name,
      status: e.status,
      attempts: e.attempts,
      payload_bytes: e.payload_size,
      idempotency_key: e.idempotency_key ?? '',
      created_at: e.created_at,
    }))
    downloadFile(`heimdall-events-page-${filters.page}.csv`, toCsv(rows))
  }

  return (
    <>
      <PageHeader
        title="Events"
        description="Every event you’ve sent, and what happened when we delivered it."
        actions={
          <Button variant="secondary" onClick={exportCsv} disabled={!data?.items.length}>
            <Download /> Export CSV
          </Button>
        }
      />

      <div className="mb-4 grid gap-2 sm:grid-cols-2 lg:flex lg:flex-wrap lg:items-center" role="group" aria-label="Filter events">
        <div className="relative sm:col-span-2 lg:w-72">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-faint" aria-hidden />
          <Input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Event ID or type, e.g. order.created"
            aria-label="Search by event ID or type"
            className="h-9 pl-9"
          />
        </div>
        <Select
          label="Endpoint"
          value={filters.endpoint_id ?? ''}
          onValueChange={(v) => setFilters({ endpoint_id: v })}
          options={endpointOptions}
          className="lg:w-48"
        />
        <Select
          label="Status"
          value={filters.status ?? ''}
          onValueChange={(v) => setFilters({ status: v as EventStatus | '' })}
          options={STATUS_OPTIONS}
          className="lg:w-40"
        />
        <div className="flex items-center gap-2 sm:col-span-2 lg:col-span-1">
          <label className="sr-only" htmlFor="from">From date</label>
          <Input
            id="from"
            type="date"
            value={filters.from}
            max={filters.to || undefined}
            onChange={(e) => setFilters({ from: e.target.value })}
            className="h-9 min-w-0 flex-1 text-sm lg:w-38 lg:flex-none"
          />
          <span className="text-faint" aria-hidden>to</span>
          <label className="sr-only" htmlFor="to">To date</label>
          <Input
            id="to"
            type="date"
            value={filters.to}
            min={filters.from || undefined}
            onChange={(e) => setFilters({ to: e.target.value })}
            className="h-9 min-w-0 flex-1 text-sm lg:w-38 lg:flex-none"
          />
        </div>
        {active && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setSearch('')
              setFilters({ search: '', status: '', endpoint_id: '', from: '', to: '' })
            }}
          >
            <X /> Clear filters
          </Button>
        )}
      </div>

      <Panel className={isPlaceholderData ? 'opacity-70 transition-opacity' : undefined}>
        {isError ? (
          <ErrorState error={error} onRetry={() => refetch()} />
        ) : !isPending && data?.items.length === 0 ? (
          active ? (
            <EmptyState
              icon={<Search />}
              title="No events match these filters"
              description="Try a wider date range or a different status."
              action={
                <Button
                  variant="secondary"
                  onClick={() => {
                    setSearch('')
                    setFilters({ search: '', status: '', endpoint_id: '', from: '', to: '' })
                  }}
                >
                  Clear filters
                </Button>
              }
            />
          ) : (
            <EmptyState
              icon={<Activity />}
              title="No events yet"
              description="Events appear here as soon as you send them to one of your endpoints."
            />
          )
        ) : (
          <>
            <EventsTable
              events={data?.items ?? []}
              loading={isPending}
              sort={filters.sort}
              onSortChange={(sort) => setFilters({ sort })}
            />
            {data && <Pagination pagination={data.pagination} onPageChange={(page) => setFilters({ page })} />}
          </>
        )}
      </Panel>
    </>
  )
}
