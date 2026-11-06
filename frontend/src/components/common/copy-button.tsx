import { Check, Copy } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    // Fallback for non-secure contexts
    const ta = document.createElement('textarea')
    ta.value = text
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    const ok = document.execCommand('copy')
    ta.remove()
    return ok
  }
}

interface CopyButtonProps {
  value: string
  label: string
  className?: string
  showText?: boolean
}

export function CopyButton({ value, label, className, showText }: CopyButtonProps) {
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const t = setTimeout(() => setCopied(false), 1600)
    return () => clearTimeout(t)
  }, [copied])

  return (
    <Button
      type="button"
      variant="ghost"
      size={showText ? 'sm' : 'icon-sm'}
      className={cn(copied && 'text-success hover:text-success', className)}
      aria-label={copied ? 'Copied' : label}
      title={label}
      onClick={async (e) => {
        e.stopPropagation()
        if (await copyText(value)) setCopied(true)
      }}
    >
      {copied ? <Check /> : <Copy />}
      {showText && <span>{copied ? 'Copied' : 'Copy'}</span>}
      <span className="sr-only" aria-live="polite">
        {copied ? 'Copied to clipboard' : ''}
      </span>
    </Button>
  )
}

/** Monospace identifier with a copy affordance. */
export function MonoId({ value, display, className }: { value: string; display?: string; className?: string }) {
  return (
    <span className={cn('inline-flex max-w-full min-w-0 items-center gap-0.5', className)}>
      <code className="mono-tight truncate text-sm text-foreground" title={value}>
        {display ?? value}
      </code>
      <CopyButton value={value} label="Copy ID" className="-my-1 size-7 text-faint" />
    </span>
  )
}
