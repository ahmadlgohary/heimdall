import { useNavigate, Link } from 'react-router'
import { HttpCode, StatusPill } from '@/components/common/status'
import { Skeleton } from '@/components/ui/skeleton'
import { formatMs, formatShortTime } from '@/lib/utils'
import type { ActivityItem } from '@/types/api'

/** Recent deliveries. A table from md up, stacked rows below. */
export function ActivityTable({ items, loading }: { items: ActivityItem[]; loading?: boolean }) {
  const navigate = useNavigate()

  if (loading) {
    return (
      <div className="grid gap-3 p-5">
        {Array.from({ length: 5 }).map((_, i) => (
          <Skeleton key={i} className="h-6" />
        ))}
      </div>
    )
  }
  if (items.length === 0) {
    return <p className="px-5 py-10 text-center text-base text-muted">No deliveries yet.</p>
  }

  return (
    <>
      <table className="hidden w-full text-base md:table">
        <thead>
          <tr className="border-b border-border text-left text-sm text-muted">
            <th scope="col" className="px-5 py-2.5 font-medium">Event</th>
            <th scope="col" className="px-3 py-2.5 font-medium">Endpoint</th>
            <th scope="col" className="px-3 py-2.5 font-medium">Status</th>
            <th scope="col" className="px-3 py-2.5 text-right font-medium">Response</th>
            <th scope="col" className="px-3 py-2.5 text-right font-medium">Duration</th>
            <th scope="col" className="px-5 py-2.5 text-right font-medium">Time</th>
          </tr>
        </thead>
        <tbody>
          {items.map((it) => (
            <tr
              key={`${it.event_id}-${it.delivery_id}`}
              onClick={() => navigate(`/events/${it.event_id}`)}
              className="cursor-pointer border-b border-border last:border-0 hover:bg-surface-hover"
            >
              <td className="px-5 py-2.5">
                <Link to={`/events/${it.event_id}`} className="font-medium hover:text-primary" onClick={(e) => e.stopPropagation()}>
                  {it.event_type}
                </Link>
              </td>
              <td className="max-w-48 truncate px-3 py-2.5 text-muted">{it.endpoint_name}</td>
              <td className="px-3 py-2.5">
                <StatusPill status={it.status} />
              </td>
              <td className="px-3 py-2.5 text-right">
                <HttpCode status={it.http_status} />
              </td>
              <td className="tabular px-3 py-2.5 text-right text-muted">{formatMs(it.duration_ms)}</td>
              <td className="tabular px-5 py-2.5 text-right text-muted">{formatShortTime(it.created_at)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <ul className="divide-y divide-border md:hidden">
        {items.map((it) => (
          <li key={`${it.event_id}-${it.delivery_id}`}>
            <Link to={`/events/${it.event_id}`} className="grid grid-cols-[minmax(0,1fr)] gap-1.5 px-4 py-3 hover:bg-surface-hover">
              <div className="flex items-center justify-between gap-3">
                <span className="truncate font-medium">{it.event_type}</span>
                <StatusPill status={it.status} />
              </div>
              <div className="flex items-center gap-3 text-sm text-muted">
                <span className="min-w-0 flex-1 truncate">{it.endpoint_name}</span>
                <HttpCode status={it.http_status} />
                <span className="tabular">{formatMs(it.duration_ms)}</span>
                <span className="tabular">{formatShortTime(it.created_at)}</span>
              </div>
            </Link>
          </li>
        ))}
      </ul>
    </>
  )
}
