import { ChevronLeft, ChevronRight } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { formatNumber } from '@/lib/utils'
import type { Pagination as P } from '@/types/api'

export function Pagination({ pagination, onPageChange }: { pagination: P; onPageChange: (page: number) => void }) {
  const { page, limit, total, total_pages } = pagination
  const from = total === 0 ? 0 : (page - 1) * limit + 1
  const to = Math.min(page * limit, total)
  return (
    <nav aria-label="Pagination" className="flex items-center justify-between gap-4 border-t border-border px-4 py-2.5 sm:px-5">
      <p className="tabular text-sm text-muted">
        {formatNumber(from)}–{formatNumber(to)} of {formatNumber(total)}
      </p>
      <div className="flex items-center gap-1">
        <Button variant="ghost" size="icon-sm" aria-label="Previous page" disabled={page <= 1} onClick={() => onPageChange(page - 1)}>
          <ChevronLeft />
        </Button>
        <span className="tabular min-w-16 text-center text-sm text-muted">
          Page {page} of {Math.max(total_pages, 1)}
        </span>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Next page"
          disabled={page >= total_pages}
          onClick={() => onPageChange(page + 1)}
        >
          <ChevronRight />
        </Button>
      </div>
    </nav>
  )
}
