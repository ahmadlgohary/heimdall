import { render } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { AppProviders } from '@/App'
import { db, DEMO } from '@/mocks/db'
import { routes } from '@/routes'

/** Start the app signed in as the seeded demo user (the mock reads this as the refresh cookie). */
export function signInAsDemo() {
  const user = db.users.find((u) => u.email === DEMO.email)!
  localStorage.setItem('heimdall.mock.session', user.id)
  return user
}

/** Sign in as a brand-new account with no data. */
export function signInAsNewUser() {
  const user = { id: 'new-user-id', email: 'new@example.com', password: 'NewPassword123', created_at: new Date().toISOString() }
  db.users.push(user)
  localStorage.setItem('heimdall.mock.session', user.id)
  return user
}

export function renderApp(path: string) {
  const router = createMemoryRouter(routes, { initialEntries: [path] })
  const user = userEvent.setup()
  const utils = render(
    <AppProviders>
      <RouterProvider router={router} />
    </AppProviders>,
  )
  return { ...utils, router, user }
}
