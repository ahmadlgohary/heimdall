import { Eye, EyeOff, ShieldAlert } from 'lucide-react'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { CopyButton } from './copy-button'

/** Shows a one-time secret with a clear warning that it won't be shown again. */
export function SecretReveal({ value, label, notice }: { value: string; label: string; notice: string }) {
  const [visible, setVisible] = useState(true)
  return (
    <div className="grid gap-3">
      <div className="flex items-start gap-2.5 rounded-md border border-warning/30 bg-warning-soft px-3 py-2.5 text-sm text-warning">
        <ShieldAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
        <p>{notice}</p>
      </div>
      <div className="grid gap-1.5">
        <span className="text-sm font-medium">{label}</span>
        <div className="flex items-center gap-1 rounded-md border border-border-strong bg-sunken py-1 pr-1 pl-3">
          <code className="mono-tight min-w-0 flex-1 overflow-x-auto py-1.5 text-sm whitespace-nowrap select-all" data-testid="secret-value">
            {visible ? value : '•'.repeat(Math.min(value.length, 40))}
          </code>
          <Button variant="ghost" size="icon-sm" aria-label={visible ? 'Hide secret' : 'Show secret'} onClick={() => setVisible((v) => !v)}>
            {visible ? <EyeOff /> : <Eye />}
          </Button>
          <CopyButton value={value} label={`Copy ${label.toLowerCase()}`} />
        </div>
      </div>
    </div>
  )
}
