import { Check, ChevronDown } from 'lucide-react'
import { Select as S } from 'radix-ui'
import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

export interface SelectOption {
  value: string
  label: ReactNode
}

interface SelectProps {
  value: string
  onValueChange: (v: string) => void
  options: SelectOption[]
  placeholder?: string
  label: string
  className?: string
  icon?: ReactNode
}

/** Radix Select can't hold an empty value, so "all" maps to ''. */
const ALL = '__all__'

export function Select({ value, onValueChange, options, placeholder, label, className, icon }: SelectProps) {
  return (
    <S.Root value={value === '' ? ALL : value} onValueChange={(v) => onValueChange(v === ALL ? '' : v)}>
      <S.Trigger
        aria-label={label}
        className={cn(
          'inline-flex h-9 min-w-0 items-center gap-2 rounded-md border border-border-strong bg-surface px-3 text-base text-foreground outline-none',
          'hover:bg-surface-hover focus-visible:border-primary focus-visible:ring-3 focus-visible:ring-primary-soft data-[placeholder]:text-muted',
          className,
        )}
      >
        {icon && <span className="text-muted [&_svg]:size-4">{icon}</span>}
        <span className="min-w-0 flex-1 truncate text-left">
          <S.Value placeholder={placeholder} />
        </span>
        <S.Icon>
          <ChevronDown className="size-4 text-muted" />
        </S.Icon>
      </S.Trigger>
      <S.Portal>
        <S.Content
          position="popper"
          sideOffset={6}
          className="z-50 max-h-80 min-w-[var(--radix-select-trigger-width)] overflow-hidden rounded-md border border-border-strong bg-surface shadow-pop data-[state=open]:animate-pop-in"
        >
          <S.Viewport className="p-1">
            {options.map((o) => (
              <S.Item
                key={o.value || ALL}
                value={o.value === '' ? ALL : o.value}
                className="relative flex h-9 cursor-pointer items-center rounded-sm pr-8 pl-2.5 text-base outline-none select-none data-[highlighted]:bg-surface-hover"
              >
                <S.ItemText>{o.label}</S.ItemText>
                <S.ItemIndicator className="absolute right-2.5">
                  <Check className="size-4 text-primary" />
                </S.ItemIndicator>
              </S.Item>
            ))}
          </S.Viewport>
        </S.Content>
      </S.Portal>
    </S.Root>
  )
}
