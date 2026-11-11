import { screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { db, deliveriesFor } from '@/mocks/db'
import { renderApp, signInAsDemo, signInAsSeededOwner } from '../utils'

const rows = (table: HTMLElement) => within(table).getAllByRole('row').slice(1)

describe('event explorer', () => {
  it('filters by status', async () => {
    signInAsDemo()
    const { user, router } = renderApp('/events')
    const table = await screen.findByRole('table')
    await waitFor(() => expect(rows(table).length).toBe(20))

    await user.click(screen.getByRole('combobox', { name: 'Status' }))
    await user.click(await screen.findByRole('option', { name: 'Failed' }))

    await waitFor(() => expect(router.state.location.search).toContain('status=failed'))
    await waitFor(() => {
      const r = rows(screen.getByRole('table'))
      expect(r.length).toBeGreaterThan(0)
      r.forEach((row) => expect(within(row).getByText('Failed')).toBeInTheDocument())
    })
  })

  it('searches by event type', async () => {
    signInAsDemo()
    const { user } = renderApp('/events')
    await screen.findByRole('table')
    await user.type(screen.getByRole('searchbox', { name: 'Search by event ID or type' }), 'invoice.paid')
    await waitFor(
      () => {
        const r = rows(screen.getByRole('table'))
        expect(r.length).toBeGreaterThan(0)
        r.forEach((row) => expect(row).toHaveTextContent('invoice.paid'))
      },
      { timeout: 4000 },
    )
  })

  it('paginates', async () => {
    signInAsDemo()
    const { user } = renderApp('/events')
    await screen.findByRole('table')
    expect(await screen.findByText(/^Page 1 of \d+$/)).toBeInTheDocument()
    const first = rows(screen.getByRole('table'))[0].textContent
    await user.click(screen.getByRole('button', { name: 'Next page' }))
    expect(await screen.findByText(/^Page 2 of \d+$/)).toBeInTheDocument()
    await waitFor(() => expect(rows(screen.getByRole('table'))[0].textContent).not.toBe(first))
  })
})

describe('event details', () => {
  function settledFailedEvent() {
    const d = db.deliveries.find((x) => x.status === 'failed' && deliveriesFor(x.event_id).length === 1)!
    return db.events.find((e) => e.id === d.event_id)!
  }

  it('renders metadata, attempts and the JSON payload', async () => {
    signInAsDemo()
    const ev = settledFailedEvent()
    renderApp(`/events/${ev.id}`)
    expect(await screen.findByRole('heading', { level: 1, name: ev.event_type })).toBeInTheDocument()
    expect(await screen.findByRole('list', { name: 'Attempts for execution 1' })).toBeInTheDocument()
    const payload = await screen.findByLabelText('Event payload')
    await waitFor(() => expect(payload.textContent).toContain(`"id": "${ev.id}"`))
    expect(screen.getAllByRole('button', { name: 'Copy JSON' }).length).toBeGreaterThan(0)
  })

  it('requires confirmation before replaying, then adds a manual execution', async () => {
    signInAsSeededOwner()
    const ev = settledFailedEvent()
    // make sure the endpoint accepts replays
    db.endpoints.find((e) => e.id === ev.endpoint_id)!.enabled = true
    const { user } = renderApp(`/events/${ev.id}`)

    const replay = await screen.findByRole('button', { name: 'Replay event' })
    await waitFor(() => expect(replay).toBeEnabled())
    await user.click(replay)
    const dialog = await screen.findByRole('alertdialog', { name: 'Replay this event?' })
    expect(deliveriesFor(ev.id)).toHaveLength(1)

    await user.click(within(dialog).getByRole('button', { name: 'Replay event' }))
    await waitFor(() => expect(deliveriesFor(ev.id)).toHaveLength(2))
    expect(deliveriesFor(ev.id)[1].trigger_type).toBe('manual')
    expect(await screen.findByRole('heading', { name: 'Execution 2' })).toBeInTheDocument()
    expect(screen.getByText('Manual replay')).toBeInTheDocument()
  })

  it('refreshes retry status while a delivery is in progress', async () => {
    signInAsDemo()
    const ev = db.events.find((e) => e.idempotency_key === 'ship-demo-retry')!
    const d = deliveriesFor(ev.id)[0]
    renderApp(`/events/${ev.id}`)
    expect(await screen.findByText('Next retry')).toBeInTheDocument()

    // the scheduled retry comes due; the next poll should pick up the success
    d.next_attempt_at = new Date(Date.now() - 1000).toISOString()
    await waitFor(() => expect(screen.getAllByText('Delivered').length).toBeGreaterThan(0), { timeout: 9000 })
  })
})
