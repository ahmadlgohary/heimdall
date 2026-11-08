import { screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { db } from '@/mocks/db'
import { renderApp, signInAsDemo } from '../utils'

async function desktopTable() {
  const table = await screen.findByRole('table')
  await within(table).findByText('Production orders')
  return table
}

describe('endpoints', () => {
  it('lists the user’s endpoints', async () => {
    signInAsDemo()
    renderApp('/endpoints')
    const table = await desktopTable()
    for (const name of ['Production orders', 'Billing service', 'Slack relay', 'Legacy CRM']) {
      expect(within(table).getByText(name)).toBeInTheDocument()
    }
  })

  it('opens the create modal and creates a valid endpoint, revealing the secret once', async () => {
    signInAsDemo()
    const { user } = renderApp('/endpoints')
    await desktopTable()
    await user.click(screen.getAllByRole('button', { name: 'Add endpoint' })[0])
    const dialog = await screen.findByRole('dialog', { name: 'Add endpoint' })
    await user.type(within(dialog).getByLabelText('Name'), 'Orders v2')
    await user.type(within(dialog).getByLabelText('Destination URL'), 'https://api.example.com/hooks')
    await user.click(within(dialog).getByRole('button', { name: 'Add endpoint' }))

    const done = await screen.findByRole('dialog', { name: 'Endpoint added' })
    expect(within(done).getByTestId('secret-value').textContent).toMatch(/^whsec_/)
    expect(db.endpoints.some((e) => e.name === 'Orders v2')).toBe(true)
  })

  it('shows the API’s error for a private destination', async () => {
    signInAsDemo()
    const { user } = renderApp('/endpoints?new=1')
    const dialog = await screen.findByRole('dialog', { name: 'Add endpoint' })
    await user.type(within(dialog).getByLabelText('Name'), 'Local')
    await user.type(within(dialog).getByLabelText('Destination URL'), 'https://localhost:3000/hook')
    await user.click(within(dialog).getByRole('button', { name: 'Add endpoint' }))
    expect(await within(dialog).findByText('Private and local network addresses can’t receive webhooks.')).toBeInTheDocument()
  })

  it('surfaces server-side URL validation on the field', async () => {
    signInAsDemo()
    const { user } = renderApp('/endpoints?new=1')
    const dialog = await screen.findByRole('dialog', { name: 'Add endpoint' })
    await user.type(within(dialog).getByLabelText('Name'), 'Plain http')
    await user.type(within(dialog).getByLabelText('Destination URL'), 'http://example.com/hook')
    await user.click(within(dialog).getByRole('button', { name: 'Add endpoint' }))
    expect(await within(dialog).findByText('Destination URLs must use HTTPS.')).toBeInTheDocument()
  })

  it('disables an endpoint', async () => {
    signInAsDemo()
    const { user } = renderApp('/endpoints')
    const table = await desktopTable()
    const toggle = within(table).getByRole('switch', { name: 'Disable Production orders' })
    expect(toggle).toBeChecked()
    await user.click(toggle)
    await waitFor(() => expect(db.endpoints.find((e) => e.name === 'Production orders')!.enabled).toBe(false))
    expect(await within(table).findByRole('switch', { name: 'Enable Production orders' })).not.toBeChecked()
  })

  it('deletes an endpoint only after confirmation', async () => {
    signInAsDemo()
    const { user } = renderApp('/endpoints')
    const table = await desktopTable()
    await user.click(within(table).getByRole('button', { name: 'Actions for Slack relay' }))
    await user.click(await screen.findByRole('menuitem', { name: 'Delete' }))

    const confirm = await screen.findByRole('alertdialog', { name: 'Delete Slack relay?' })
    expect(db.endpoints.some((e) => e.name === 'Slack relay')).toBe(true)
    await user.click(within(confirm).getByRole('button', { name: 'Delete endpoint' }))

    await waitFor(() => expect(db.endpoints.some((e) => e.name === 'Slack relay')).toBe(false))
    await waitFor(() => expect(within(table).queryByText('Slack relay')).not.toBeInTheDocument())
  })

  it('rotates a signing secret after confirmation', async () => {
    signInAsDemo()
    const before = db.endpoints.find((e) => e.name === 'Billing service')!.signing_secret
    const { user } = renderApp('/endpoints')
    const table = await desktopTable()
    await user.click(within(table).getByRole('button', { name: 'Actions for Billing service' }))
    await user.click(await screen.findByRole('menuitem', { name: 'Rotate signing secret' }))
    const confirm = await screen.findByRole('alertdialog')
    await user.click(within(confirm).getByRole('button', { name: 'Rotate secret' }))
    const shown = await screen.findByTestId('secret-value')
    const after = db.endpoints.find((e) => e.name === 'Billing service')!.signing_secret
    expect(after).not.toBe(before)
    expect(shown.textContent).toBe(after)
  })
})
