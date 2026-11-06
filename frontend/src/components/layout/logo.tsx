import { cn } from '@/lib/utils'

export function LogoMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" aria-hidden className={cn('size-7 shrink-0', className)}>
      <rect width="32" height="32" rx="8" fill="var(--primary)" />
      <path d="M6 11h11a5 5 0 0 1 0 10h-4" fill="none" stroke="var(--primary-foreground)" strokeWidth="3" strokeLinecap="round" />
      <circle cx="11" cy="21" r="2.6" fill="var(--primary-foreground)" />
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
