import type { ComponentProps } from 'react'
import { cn } from '@/lib/utils'

export function Input({ className, ...props }: ComponentProps<'input'>) {
  return (
    <input
      className={cn(
        'h-10 w-full min-w-0 rounded-md border border-border-strong bg-sunken px-3 text-base text-foreground placeholder:text-faint',
        'transition-[border-color,box-shadow] outline-none focus-visible:border-primary focus-visible:ring-3 focus-visible:ring-primary-soft focus-visible:outline-none',
        'aria-invalid:border-danger aria-invalid:focus-visible:ring-danger-soft disabled:opacity-50',
        className,
      )}
      {...props}
    />
  )
}

export function Textarea({ className, ...props }: ComponentProps<'textarea'>) {
  return (
    <textarea
      className={cn(
        'min-h-20 w-full rounded-md border border-border-strong bg-sunken px-3 py-2 text-base text-foreground placeholder:text-faint',
        'outline-none focus-visible:border-primary focus-visible:ring-3 focus-visible:ring-primary-soft focus-visible:outline-none',
        'aria-invalid:border-danger',
        className,
      )}
      {...props}
    />
  )
}
