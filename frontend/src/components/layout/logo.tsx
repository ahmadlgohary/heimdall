import { cn } from '@/lib/utils'
import { KNOT_PATH, KNOT_TRANSFORM } from './knot-path'

export function LogoMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" aria-hidden className={cn('size-7 shrink-0', className)}>
      <rect width="32" height="32" rx="8" fill="var(--primary)" />
      <g transform={KNOT_TRANSFORM}>
        <path d={KNOT_PATH} fill="var(--primary-foreground)" />
      </g>
    </svg>
  )
}

export function Logo({ compact, className }: { compact?: boolean; className?: string }) {
  return (
    <span className={cn('flex items-center gap-2.5', className)}>
      <LogoMark />
      {!compact && <span className="display text-lg font-semibold tracking-tight">Heimdall</span>}
    </span>
  )
}
