import { screen, within } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { describe, expect, it } from 'vitest'
import { server } from '../setup'
import { renderApp, signInAsDemo, signInAsNewUser } from '../utils'

describe('dashboard', () => {
  it('loads statistics from the API', async () => {
    signInAsDemo()
    let requested = ''
    server.events.on('request:start', ({ request }) => {
      if (request.url.includes('/dashboard/stats')) requested = request.url
    })
    renderApp('/dashboard')
    const stat = await screen.findByText('Events received')
    const cell = stat.closest('div')!
    expect(await within(cell).findByText(/^\d[\d,]*$/)).toBeInTheDocument()
    expect(requested).toContain('range=24h')
    expect(screen.getByRole('meter', { name: 'Success rate' })).toBeInTheDocument()
  })

  it('renders chart panels and recent activity from returned data', async () => {
    signInAsDemo()
    renderApp('/dashboard')
    expect(await screen.findByRole('heading', { name: 'Event volume' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Response time' })).toBeInTheDocument()
    expect(await screen.findByRole('list', { name: 'Recent deliveries over time' })).toBeInTheDocument()
    expect((await screen.findAllByRole('listitem', { name: /to .*: / })).length).toBeGreaterThan(5)
  })

  it('shows an empty state for a new account', async () => {
    signInAsNewUser()
    renderApp('/dashboard')
    expect(await screen.findByText('No events yet')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Add an endpoint' })).toBeInTheDocument()
  })

  it('shows loading placeholders before data arrives', async () => {
    signInAsDemo()
    const { container } = renderApp('/dashboard')
    await screen.findByRole('heading', { name: 'Overview' })
    expect(container.querySelector('.animate-pulse')).not.toBeNull()
  })

  it('handles API errors with a retry action', async () => {
    signInAsDemo()
    server.use(
      http.get('*/api/v1/dashboard/stats', () =>
        HttpResponse.json({ error: { code: 'INTERNAL', message: 'Database unavailable.', details: null } }, { status: 500 }),
      ),
    )
    renderApp('/dashboard')
    expect(await screen.findByText('Database unavailable.', {}, { timeout: 8000 })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument()
  })
})
