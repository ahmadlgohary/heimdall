import { Tooltip } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

/**
 * Marks seeded demo history. Its delivery attempts were simulated by the seed
 * script, so it must never pass for real processing (plan §14.3).
 */
export function SampleTag({ className }: { className?: string }) {
  return (
    <Tooltip content="Sample data from the demo seed. Its delivery attempts were simulated, not sent.">
      <span
        tabIndex={0}
        className={cn(
          'inline-flex h-5 shrink-0 items-center rounded-sm border border-dashed border-border-strong px-1.5 text-xs font-normal text-muted outline-none focus-visible:ring-2 focus-visible:ring-ring',
          className,
        )}
      >
        Sample
      </span>
    </Tooltip>
  )
}
