import type { EventStatus } from '@/types/api'
import { cn, httpStatusTone } from '@/lib/utils'

const STATUS: Record<EventStatus, { label: string; text: string; bg: string; dot: string }> = {
  delivered: { label: 'Delivered', text: 'text-success', bg: 'bg-success-soft', dot: 'bg-success' },
  failed: { label: 'Failed', text: 'text-danger', bg: 'bg-danger-soft', dot: 'bg-danger' },
  retrying: { label: 'Retrying', text: 'text-warning', bg: 'bg-warning-soft', dot: 'border-[1.5px] border-dashed border-warning' },
  delivering: { label: 'Delivering', text: 'text-primary', bg: 'bg-primary-soft', dot: 'bg-primary animate-pulse-dot' },
  queued: { label: 'Queued', text: 'text-muted', bg: 'bg-neutral-soft', dot: 'border-[1.5px] border-muted' },
}

// eslint-disable-next-line react-refresh/only-export-components
export const statusLabel = (s: EventStatus) => STATUS[s]?.label ?? s

export function StatusPill({ status, className }: { status: EventStatus; className?: string }) {
  const s = STATUS[status] ?? STATUS.queued
  return (
    <span
      className={cn(
        'inline-flex h-6 items-center gap-1.5 rounded-full pr-2.5 pl-2 text-sm font-medium whitespace-nowrap',
        s.text,
        s.bg,
        className,
      )}
    >
      <span aria-hidden className={cn('size-2 shrink-0 rounded-full', s.dot)} />
      {s.label}
    </span>
  )
}

/** Small status glyph used in dense lists and the delivery trace. */
export function StatusDot({ status, className }: { status: EventStatus; className?: string }) {
  const s = STATUS[status] ?? STATUS.queued
  return <span aria-label={s.label} role="img" className={cn('inline-block size-2 shrink-0 rounded-full', s.dot, className)} />
}

const TONE = {
  success: 'text-success',
  warning: 'text-warning',
  danger: 'text-danger',
  neutral: 'text-faint',
}

export function HttpCode({ status, className }: { status: number | null | undefined; className?: string }) {
  return (
    <span className={cn('mono-tight tabular text-sm font-medium', TONE[httpStatusTone(status)], className)}>
      {status ?? '—'}
    </span>
  )
}
