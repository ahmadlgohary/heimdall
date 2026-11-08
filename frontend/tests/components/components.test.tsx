import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router'
import { describe, expect, it, vi } from 'vitest'
import { DeliveryWire } from '@/components/dashboard/delivery-wire'
import { AttemptTrace } from '@/components/events/attempt-trace'
import { JsonViewer } from '@/components/common/json-viewer'
import { HttpCode, StatusPill } from '@/components/common/status'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { Delivery, DeliveryAttempt } from '@/types/api'

const delivery = (over: Partial<Delivery> = {}): Delivery => ({
  id: 'd1',
  event_id: 'e1',
  execution_number: 1,
  trigger_type: 'automatic',
  status: 'retrying',
  current_attempt: 1,
  max_attempts: 5,
  next_attempt_at: new Date(Date.now() + 90_000).toISOString(),
  started_at: null,
  completed_at: null,
  created_at: new Date().toISOString(),
  last_http_status: 500,
  last_duration_ms: 120,
  ...over,
})

const attempt = (n: number, status: number | null, over: Partial<DeliveryAttempt> = {}): DeliveryAttempt => ({
  id: `a${n}`,
  delivery_id: 'd1',
  attempt_number: n,
  http_status: status,
  response_body: null,
  response_headers: null,
  duration_ms: 120,
  error_message: null,
  attempted_at: new Date(Date.now() - (5 - n) * 60_000).toISOString(),
  ...over,
})

describe('StatusPill & HttpCode', () => {
  it('labels every status with text, not colour alone', () => {
    render(
      <>
        <StatusPill status="delivered" />
        <StatusPill status="failed" />
        <StatusPill status="retrying" />
      </>,
    )
    expect(screen.getByText('Delivered')).toBeInTheDocument()
    expect(screen.getByText('Failed')).toBeInTheDocument()
    expect(screen.getByText('Retrying')).toBeInTheDocument()
  })

  it('tones HTTP codes by class', () => {
    render(
      <>
        <HttpCode status={200} />
        <HttpCode status={503} />
        <HttpCode status={429} />
      </>,
    )
    expect(screen.getByText('200')).toHaveClass('text-success')
    expect(screen.getByText('503')).toHaveClass('text-danger')
    expect(screen.getByText('429')).toHaveClass('text-warning')
  })
})

describe('AttemptTrace', () => {
  it('draws each attempt and the scheduled retry with a countdown', () => {
    render(<AttemptTrace delivery={delivery()} attempts={[attempt(1, 500)]} />)
    expect(screen.getByRole('button', { name: /Attempt 1: HTTP 500/ })).toBeInTheDocument()
    expect(screen.getByText('Next retry')).toBeInTheDocument()
    expect(screen.getByText(/^in 1m 2\ds|^in 1m 30s$/)).toBeInTheDocument()
    expect(screen.getByLabelText('3 attempts remaining')).toBeInTheDocument()
  })

  it('reports the selected attempt', async () => {
    const onSelect = vi.fn()
    render(
      <AttemptTrace
        delivery={delivery({ status: 'delivered', next_attempt_at: null })}
        attempts={[attempt(1, 500), attempt(2, 200)]}
        onSelect={onSelect}
      />,
    )
    await userEvent.click(screen.getByRole('button', { name: /Attempt 2: HTTP 200/ }))
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: 'a2' }))
    expect(screen.getByText('+1m')).toBeInTheDocument()
  })
})

describe('DeliveryWire', () => {
  it('renders one linked tick per delivery with an accessible label', () => {
    const now = Date.now()
    render(
      <MemoryRouter>
        <TooltipProvider>
          <DeliveryWire
            items={[
              { event_id: 'e1', delivery_id: 'd1', event_type: 'order.paid', endpoint_id: 'p', endpoint_name: 'Orders', status: 'delivered', http_status: 200, duration_ms: 80, created_at: new Date(now - 60_000).toISOString() },
              { event_id: 'e2', delivery_id: 'd2', event_type: 'invoice.paid', endpoint_id: 'p', endpoint_name: 'Billing', status: 'failed', http_status: 500, duration_ms: 900, created_at: new Date(now - 30_000).toISOString() },
            ]}
          />
        </TooltipProvider>
      </MemoryRouter>,
    )
    expect(screen.getByRole('listitem', { name: /order\.paid to Orders: Delivered, HTTP 200/ })).toHaveAttribute('href', '/events/e1')
    expect(screen.getByRole('listitem', { name: /invoice\.paid to Billing: Failed, HTTP 500/ })).toHaveAttribute('href', '/events/e2')
    expect(screen.getByText(/1 succeeded or in progress, 1 failed or retrying/)).toBeInTheDocument()
  })
})

describe('JsonViewer', () => {
  it('shows read-only JSON and copies it', async () => {
    const user = userEvent.setup()
    const writeText = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue()
    render(<JsonViewer value={{ order_id: 'ORD-1', amount: 12.5 }} title="Payload" />)
    const editor = screen.getByLabelText('Payload')
    expect(editor).toHaveTextContent('"order_id": "ORD-1"')
    expect(editor).toHaveAttribute('contenteditable', 'false')
    await user.click(screen.getByRole('button', { name: 'Copy JSON' }))
    expect(writeText).toHaveBeenCalledWith(JSON.stringify({ order_id: 'ORD-1', amount: 12.5 }, null, 2))
    expect(await screen.findByRole('button', { name: 'Copied' })).toBeInTheDocument()
  })
})
