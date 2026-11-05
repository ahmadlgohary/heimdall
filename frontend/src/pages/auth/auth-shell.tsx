import type { ReactNode } from 'react'
import { Logo } from '@/components/layout/logo'
import { IS_MOCK } from '@/components/layout/app-sidebar'

/** A quiet backdrop: one delivery wire crossing the page behind the form. */
function BackdropWire() {
  const ticks = [
    [6, 18], [11, -10], [14, 26], [22, 14], [27, 30], [31, -22], [38, 12], [44, 20], [52, 34], [57, 16],
    [63, -14], [68, 24], [74, 10], [79, 28], [85, 18], [90, -26], [94, 12],
  ]
  return (
    <svg aria-hidden className="pointer-events-none absolute inset-x-0 top-[22%] h-24 w-full opacity-60 sm:top-1/2 sm:-translate-y-1/2" preserveAspectRatio="none" viewBox="0 0 100 80">
      <line x1="0" y1="40" x2="100" y2="40" stroke="var(--border-strong)" strokeWidth="0.15" vectorEffect="non-scaling-stroke" />
      {ticks.map(([x, h]) => (
        <line
          key={x}
          x1={x}
          x2={x}
          y1={40}
          y2={40 - h}
          stroke={h > 0 ? 'var(--chart-ok)' : 'var(--chart-fail)'}
          strokeOpacity={0.35}
          strokeWidth={3}
          strokeLinecap="round"
          vectorEffect="non-scaling-stroke"
        />
      ))}
    </svg>
  )
}

export function AuthShell({ title, subtitle, children, footer }: { title: string; subtitle: ReactNode; children: ReactNode; footer: ReactNode }) {
  return (
    <div className="relative flex min-h-dvh flex-col items-center justify-center overflow-hidden px-4 py-10">
      <BackdropWire />
      <main className="relative w-full max-w-[400px]">
        <Logo className="mb-8 justify-center" />
        <div className="rounded-lg border border-border-strong bg-surface/95 p-6 shadow-pop backdrop-blur-sm sm:p-7">
          <h1 className="display text-xl font-semibold">{title}</h1>
          <p className="mt-1 text-base text-muted">{subtitle}</p>
          <div className="mt-6">{children}</div>
        </div>
        <p className="mt-6 text-center text-base text-muted">{footer}</p>
        {IS_MOCK && (
          <p className="mt-3 text-center text-sm text-faint">
            Mock API is on. Sign in with demo@heimdall.dev and DemoPassword123.
          </p>
        )}
      </main>
    </div>
  )
}
