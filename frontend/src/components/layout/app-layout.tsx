import { Outlet } from 'react-router'
import { AppHeader } from './app-header'
import { AppSidebar } from './app-sidebar'

export function AppLayout() {
  return (
    <div className="min-h-dvh">
      <a
        href="#main"
        className="sr-only z-50 rounded-md bg-primary px-3 py-2 text-primary-foreground focus:not-sr-only focus:fixed focus:top-3 focus:left-3"
      >
        Skip to content
      </a>
      <AppSidebar />
      <div className="lg:pl-16 xl:pl-60">
        <AppHeader />
        <main id="main" tabIndex={-1} className="mx-auto w-full max-w-[1400px] px-4 pt-7 pb-16 outline-none sm:px-6 lg:px-8">
          <Outlet />
        </main>
      </div>
    </div>
  )
}
