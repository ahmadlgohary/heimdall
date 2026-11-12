import { screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { db, DEMO } from '@/mocks/db'
import { renderApp, signInAsDemo, signInAsNewUser } from '../utils'

describe('demo environment', () => {
  it('shows the demo credentials on the sign-in page and signs in with one click', async () => {
    const { user, router } = renderApp('/login')
    const panel = await screen.findByRole('region', { name: 'Try the demo' })
    expect(within(panel).getByText(/deleted when you sign out or after 2 hours/)).toBeInTheDocument()
    expect(within(panel).getByText(DEMO.email)).toBeInTheDocument()
    expect(within(panel).getByText(DEMO.password)).toBeInTheDocument()

    await user.click(within(panel).getByRole('button', { name: 'Sign in to the demo' }))
    await waitFor(() => expect(router.state.location.pathname).toBe('/dashboard'))
    expect(await screen.findByText('This is your own copy of the demo.')).toBeInTheDocument()
  })

  it('does not show the demo notice to regular accounts', async () => {
    signInAsNewUser()
    renderApp('/dashboard')
    await screen.findByText('No events yet')
    expect(screen.queryByText('This is your own copy of the demo.')).not.toBeInTheDocument()
  })

  it('labels sample history in the event list and explains it on the event page', async () => {
    signInAsDemo()
    const { user } = renderApp('/events')
    const table = await screen.findByRole('table')
    await waitFor(() => expect(within(table).getAllByText('Sample').length).toBeGreaterThan(0))

    const fixture = db.events.find((e) => e.source === 'demo_fixture')!
    const live = db.events.find((e) => e.source === 'live')!
    await user.click(within(table).getAllByText('Sample')[0].closest('tr')!)
    expect(await screen.findByText(/sample data from the demo seed/)).toBeInTheDocument()
    expect(fixture.source).toBe('demo_fixture')
    expect(live.source).toBe('live') // the mid-retry event is not labelled as a fixture
  })

  it('locks the password of the shared account', async () => {
    signInAsDemo()
    renderApp('/settings')
    expect(await screen.findByText(/Demo copies don’t have a password/)).toBeInTheDocument()
    expect(screen.queryByLabelText('Current password')).not.toBeInTheDocument()
  })
})
