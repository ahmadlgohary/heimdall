import { Menu, Search } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { Dialog as D } from 'radix-ui'
import { useLocation, useNavigate } from 'react-router'
import { Button } from '@/components/ui/button'
import { useIsFetching } from '@tanstack/react-query'
import { cn } from '@/lib/utils'
import { EnvironmentNote, SidebarNav, UserMenu } from './app-sidebar'
import { Logo } from './logo'

function LiveIndicator() {
  const fetching = useIsFetching() > 0
  return (
    <span className="flex shrink-0 items-center gap-2 text-sm text-muted" title="Delivery data refreshes every few seconds">
      <span
        aria-hidden
        className={cn('size-1.5 rounded-full bg-success text-success', fetching && 'animate-pulse-dot')}
      />
      Live
    </span>
  )
}

function EventJump() {
  const navigate = useNavigate()
  const ref = useRef<HTMLInputElement>(null)
  const [q, setQ] = useState('')

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement
      if (e.key === '/' && !['INPUT', 'TEXTAREA'].includes(target.tagName) && !target.isContentEditable) {
        e.preventDefault()
        ref.current?.focus()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  return (
    <form
      role="search"
      className="relative w-full max-w-sm"
      onSubmit={(e) => {
        e.preventDefault()
        const term = q.trim()
        if (!term) return
        navigate(`/events?search=${encodeURIComponent(term)}`)
        setQ('')
        ref.current?.blur()
      }}
    >
      <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-faint" aria-hidden />
      <label htmlFor="event-jump" className="sr-only">
        Find events by ID or type
      </label>
      <input
        ref={ref}
        id="event-jump"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Find events by ID or type"
        className="h-9 w-full rounded-md border border-border bg-sunken pr-9 pl-9 text-base placeholder:text-faint outline-none focus-visible:border-primary focus-visible:ring-3 focus-visible:ring-primary-soft"
      />
      <kbd className="pointer-events-none absolute top-1/2 right-2 hidden -translate-y-1/2 rounded border border-border-strong px-1.5 text-xs text-faint sm:block">
        /
      </kbd>
    </form>
  )
}

export function AppHeader() {
  const [open, setOpen] = useState(false)
  const location = useLocation()

  // close the drawer whenever the route changes
  const [path, setPath] = useState(location.pathname)
  if (path !== location.pathname) {
    setPath(location.pathname)
    setOpen(false)
  }

  return (
    <header className="sticky top-0 z-20 flex h-14 items-center gap-3 border-b border-border bg-background/85 px-4 backdrop-blur-md sm:px-6">
      <D.Root open={open} onOpenChange={setOpen}>
        <D.Trigger asChild>
          <Button variant="ghost" size="icon" className="-ml-2 lg:hidden" aria-label="Open navigation">
            <Menu />
          </Button>
        </D.Trigger>
        <D.Portal>
          <D.Overlay className="fixed inset-0 z-40 bg-overlay data-[state=open]:animate-fade-in lg:hidden" />
          <D.Content
            className="fixed inset-y-0 left-0 z-50 flex w-[min(18rem,85vw)] flex-col border-r border-border bg-sidebar px-3 py-4 shadow-pop outline-none data-[state=open]:animate-[slide-in_180ms_ease-out] lg:hidden"
            aria-describedby={undefined}
          >
            <D.Title className="sr-only">Navigation</D.Title>
            <Logo className="mb-7 px-2" />
            <SidebarNav onNavigate={() => setOpen(false)} />
            <div className="mt-auto">
              <EnvironmentNote />
              <UserMenu />
            </div>
          </D.Content>
        </D.Portal>
      </D.Root>
      <Logo compact className="lg:hidden" />
      <div className="flex min-w-0 flex-1 justify-end sm:justify-start">
        <div className="hidden w-full sm:block">
          <EventJump />
        </div>
      </div>
      <LiveIndicator />
    </header>
  )
}
