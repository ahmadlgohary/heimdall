import { screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { db, DEMO } from '@/mocks/db'
import { renderApp, signInAsDemo, signInAsNewUser } from '../utils'

describe('demo environment', () => {
  it('shows the demo credentials on the sign-in page and signs in with one click', async () => {
    const { user, router } = renderApp('/login')
    const panel = await screen.findByRole('region', { name: 'Try the demo' })
    expect(within(panel).getByText(DEMO.email)).toBeInTheDocument()
    expect(within(panel).getByText(DEMO.password)).toBeInTheDocument()

    await user.click(within(panel).getByRole('button', { name: 'Sign in to the demo' }))
    await waitFor(() => expect(router.state.location.pathname).toBe('/dashboard'))
    expect(await screen.findByText('Read-only demo.')).toBeInTheDocument()
  })

  it('does not show the demo notice to regular accounts', async () => {
    signInAsNewUser()
    renderApp('/dashboard')
    await screen.findByText('No events yet')
    expect(screen.queryByText('Read-only demo.')).not.toBeInTheDocument()
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
    expect(await screen.findByText(/read-only, so its password can’t be changed/)).toBeInTheDocument()
    expect(screen.queryByLabelText('Current password')).not.toBeInTheDocument()
  })
})


describe('the demo is read-only', () => {
  it('disables every change control and explains why', async () => {
    signInAsDemo()
    renderApp('/endpoints')
    expect(await screen.findByText('Read-only demo.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Add endpoint' })).toBeDisabled()
    const table = await screen.findByRole('table')
    await waitFor(() => within(table).getAllByRole('switch').forEach((s) => expect(s).toBeDisabled()))
  })

  it('locks the endpoint page, replays and API keys', async () => {
    signInAsDemo()
    const endpoint = db.endpoints.find((e) => e.enabled)!
    const { router } = renderApp(`/endpoints/${endpoint.id}`)
    for (const name of ['Send test event', 'Edit', 'Rotate secret', 'Delete endpoint']) {
      expect(await screen.findByRole('button', { name })).toBeDisabled()
    }

    const failed = db.events.find((e) => e.source === 'demo_fixture')!
    await router.navigate(`/events/${failed.id}`)
    expect(await screen.findByRole('button', { name: 'Replay event' })).toBeDisabled()
    expect(screen.getByText('Replays are off in the read-only demo.')).toBeInTheDocument()

    await router.navigate('/settings/api-keys')
    expect(await screen.findAllByRole('button', { name: /Create key/ })).not.toHaveLength(0)
    screen.getAllByRole('button', { name: /Create key/ }).forEach((b) => expect(b).toBeDisabled())
    ;(await screen.findAllByRole('button', { name: /^Revoke/ })).forEach((b) => expect(b).toBeDisabled())
  })

  it('opening the create link directly does not open the dialog', async () => {
    signInAsDemo()
    renderApp('/endpoints?new=1')
    await screen.findByText('Read-only demo.')
    expect(screen.queryByRole('dialog', { name: 'Add endpoint' })).not.toBeInTheDocument()
  })
})
