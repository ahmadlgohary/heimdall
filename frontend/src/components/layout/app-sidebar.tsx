import { LogOut, Monitor, Moon, Sun } from 'lucide-react'
import { NavLink } from 'react-router'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Tooltip } from '@/components/ui/tooltip'
import { useAuth } from '@/contexts/auth-context'
import { useTheme } from '@/contexts/theme-context'
import { cn } from '@/lib/utils'
import { Logo } from './logo'
import { NAV_ITEMS } from './nav-items'

interface SidebarNavProps {
  /** icon-only rail (1024–1279px) */
  compact?: boolean
  onNavigate?: () => void
}

export function SidebarNav({ compact, onNavigate }: SidebarNavProps) {
  return (
    <nav aria-label="Main" className="grid gap-0.5">
      {NAV_ITEMS.map(({ to, label, icon: Icon, ...rest }) => {
        const link = (
          <NavLink
            key={to}
            to={to}
            end={'end' in rest ? rest.end : false}
            onClick={onNavigate}
            className={({ isActive }) =>
              cn(
                'relative flex h-9 items-center gap-3 rounded-md px-2.5 text-base font-medium transition-colors',
                compact && 'justify-center px-0',
                isActive
                  ? 'bg-surface-hover text-foreground before:absolute before:top-2 before:bottom-2 before:-left-3 before:w-0.5 before:rounded-full before:bg-primary'
                  : 'text-muted hover:bg-surface-hover/60 hover:text-foreground',
              )
            }
          >
            <Icon className="size-[18px] shrink-0" strokeWidth={1.75} aria-hidden />
            <span className={cn(compact && 'sr-only')}>{label}</span>
          </NavLink>
        )
        return compact ? (
          <Tooltip key={to} content={label} side="right">
            {link}
          </Tooltip>
        ) : (
          link
        )
      })}
    </nav>
  )
}

export function UserMenu({ compact }: { compact?: boolean }) {
  const { user, logout } = useAuth()
  const { preference, setPreference } = useTheme()
  const email = user?.email ?? ''
  const initial = email.slice(0, 1).toUpperCase()
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className={cn(
          'flex h-11 w-full min-w-0 items-center gap-2.5 rounded-md px-2 text-left outline-none hover:bg-surface-hover focus-visible:ring-2 focus-visible:ring-ring',
          compact && 'justify-center px-0',
        )}
        aria-label="Account menu"
      >
        <span className="grid size-7 shrink-0 place-items-center rounded-full border border-border-strong bg-surface text-sm font-semibold text-primary">
          {initial}
        </span>
        {!compact && <span className="min-w-0 flex-1 truncate text-sm text-muted">{email}</span>}
      </DropdownMenuTrigger>
      <DropdownMenuContent side={compact ? 'right' : 'top'} align={compact ? 'end' : 'start'} className="w-60">
        <DropdownMenuLabel className="truncate">{email}</DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => setPreference('dark')} aria-checked={preference === 'dark'}>
          <Moon /> Dark theme {preference === 'dark' && <span className="ml-auto text-primary">●</span>}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => setPreference('light')}>
          <Sun /> Light theme {preference === 'light' && <span className="ml-auto text-primary">●</span>}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => setPreference('system')}>
          <Monitor /> Match system {preference === 'system' && <span className="ml-auto text-primary">●</span>}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => void logout()}>
          <LogOut /> Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** Fixed desktop sidebar: full at ≥1280px, icon rail at 1024–1279px. */
export function AppSidebar() {
  return (
    <>
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-60 flex-col border-r border-border bg-sidebar px-3 py-4 xl:flex">
        <Logo className="mb-7 px-2" />
        <SidebarNav />
        <div className="mt-auto">
          <EnvironmentNote />
          <UserMenu />
        </div>
      </aside>
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-16 flex-col items-stretch border-r border-border bg-sidebar px-3 py-4 lg:flex xl:hidden">
        <Logo compact className="mb-7 justify-center" />
        <SidebarNav compact />
        <div className="mt-auto">
          <UserMenu compact />
        </div>
      </aside>
    </>
  )
}

export const IS_MOCK = import.meta.env.VITE_API_MOCKING === 'true'

/** Makes demo fixtures impossible to mistake for live processing (plan §14.3). */
export function EnvironmentNote() {
  if (!IS_MOCK) return null
  return (
    <div className="mb-3 rounded-md border border-dashed border-border-strong px-3 py-2.5 text-sm text-muted">
      <p className="font-medium text-foreground">Mock API</p>
      <p className="mt-0.5">Sample data generated in your browser, not live deliveries.</p>
    </div>
  )
}
