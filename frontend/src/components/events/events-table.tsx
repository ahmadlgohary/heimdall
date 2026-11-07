import { ArrowDown, ArrowUp } from 'lucide-react'
import { Link, useNavigate } from 'react-router'
import { StatusPill } from '@/components/common/status'
import { Skeleton } from '@/components/ui/skeleton'
import { formatDateTime, formatShortTime, shortId } from '@/lib/utils'
import type { EventSummary } from '@/types/api'

interface Props {
  events: EventSummary[]
  loading?: boolean
  hideEndpoint?: boolean
  sort?: 'created_at' | '-created_at'
  onSortChange?: (s: 'created_at' | '-created_at') => void
}

export function EventsTable({ events, loading, hideEndpoint, sort = '-created_at', onSortChange }: Props) {
  const navigate = useNavigate()

  if (loading) {
    return (
      <div className="grid gap-3 p-5" aria-busy>
        {Array.from({ length: 8 }).map((_, i) => (
          <Skeleton key={i} className="h-7" />
        ))}
      </div>
    )
  }

  const desc = sort === '-created_at'
  const SortIcon = desc ? ArrowDown : ArrowUp

  return (
    <>
      <div className="hidden overflow-x-auto md:block">
        <table className="w-full text-base">
          <thead>
            <tr className="border-b border-border text-left text-sm text-muted">
              <th scope="col" className="px-5 py-2.5 font-medium">Event ID</th>
              <th scope="col" className="px-3 py-2.5 font-medium">Type</th>
              {!hideEndpoint && <th scope="col" className="px-3 py-2.5 font-medium">Endpoint</th>}
              <th scope="col" className="px-3 py-2.5 font-medium">Status</th>
              <th scope="col" className="px-3 py-2.5 text-right font-medium">Attempts</th>
              <th
                scope="col"
                className="px-5 py-2.5 text-right font-medium"
                aria-sort={desc ? 'descending' : 'ascending'}
              >
                {onSortChange ? (
                  <button
                    type="button"
                    onClick={() => onSortChange(desc ? 'created_at' : '-created_at')}
                    className="inline-flex items-center gap-1 rounded-sm hover:text-foreground"
                  >
                    Created <SortIcon className="size-3.5" aria-hidden />
                    <span className="sr-only">, sorted {desc ? 'newest first' : 'oldest first'}. Activate to reverse.</span>
                  </button>
                ) : (
                  'Created'
                )}
              </th>
            </tr>
          </thead>
          <tbody>
            {events.map((e) => (
              <tr
                key={e.id}
                onClick={() => navigate(`/events/${e.id}`)}
                className="cursor-pointer border-b border-border last:border-0 hover:bg-surface-hover"
              >
                <td className="px-5 py-2.5">
                  <Link
                    to={`/events/${e.id}`}
                    onClick={(ev) => ev.stopPropagation()}
                    className="mono-tight text-sm text-foreground hover:text-primary"
                    title={e.id}
                  >
                    {shortId(e.id, 'evt_')}
                  </Link>
                </td>
                <td className="px-3 py-2.5 font-medium">{e.event_type}</td>
                {!hideEndpoint && <td className="max-w-48 truncate px-3 py-2.5 text-muted">{e.endpoint_name}</td>}
                <td className="px-3 py-2.5">
                  <StatusPill status={e.status} />
                </td>
                <td className="tabular px-3 py-2.5 text-right text-muted">{e.attempts}</td>
                <td className="tabular px-5 py-2.5 text-right text-muted" title={formatDateTime(e.created_at)}>
                  {formatShortTime(e.created_at)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <ul className="divide-y divide-border md:hidden">
        {events.map((e) => (
          <li key={e.id}>
            <Link to={`/events/${e.id}`} className="grid grid-cols-[minmax(0,1fr)] gap-1.5 px-4 py-3 hover:bg-surface-hover">
              <div className="flex items-center justify-between gap-3">
                <span className="truncate font-medium">{e.event_type}</span>
                <StatusPill status={e.status} />
              </div>
              <div className="flex items-center gap-3 text-sm text-muted">
                <code className="mono-tight text-foreground/80">{shortId(e.id, 'evt_')}</code>
                {!hideEndpoint && <span className="min-w-0 flex-1 truncate">{e.endpoint_name}</span>}
                <span className="tabular ml-auto">{formatShortTime(e.created_at)}</span>
              </div>
            </Link>
          </li>
        ))}
      </ul>
    </>
  )
}
