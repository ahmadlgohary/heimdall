import { ToggleGroup } from 'radix-ui'
import { cn } from '@/lib/utils'

interface SegmentedProps<T extends string> {
  value: T
  onValueChange: (v: T) => void
  options: { value: T; label: string }[]
  label: string
  className?: string
}

/** Single-choice segmented control, e.g. a time-range picker. */
export function Segmented<T extends string>({ value, onValueChange, options, label, className }: SegmentedProps<T>) {
  return (
    <ToggleGroup.Root
      type="single"
      value={value}
      onValueChange={(v) => v && onValueChange(v as T)}
      aria-label={label}
      className={cn('inline-flex h-9 items-center rounded-md border border-border-strong bg-sunken p-0.5', className)}
    >
      {options.map((o) => (
        <ToggleGroup.Item
          key={o.value}
          value={o.value}
          className="h-full rounded-[5px] px-3 text-sm font-medium text-muted outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring data-[state=on]:bg-surface-hover data-[state=on]:text-foreground data-[state=on]:shadow-[0_0_0_1px_var(--border-strong)]"
        >
          {o.label}
        </ToggleGroup.Item>
      ))}
    </ToggleGroup.Root>
  )
}
