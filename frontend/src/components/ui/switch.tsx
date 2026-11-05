import { Switch as S } from 'radix-ui'
import type { ComponentProps } from 'react'
import { cn } from '@/lib/utils'

export function Switch({ className, ...props }: ComponentProps<typeof S.Root>) {
  return (
    <S.Root
      className={cn(
        'peer relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border border-border-strong bg-sunken transition-colors outline-none',
        'focus-visible:ring-3 focus-visible:ring-primary-soft data-[state=checked]:border-transparent data-[state=checked]:bg-success disabled:opacity-50',
        // larger invisible hit area for touch
        'before:absolute before:-inset-2.5 before:content-[""]',
        className,
      )}
      {...props}
    >
      <S.Thumb className="block size-3.5 translate-x-0.5 rounded-full bg-muted shadow transition-transform data-[state=checked]:translate-x-[18px] data-[state=checked]:bg-white" />
    </S.Root>
  )
}
