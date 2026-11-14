/**
 * Edge ingestion through the Cloudflare Worker (plan §7), against the real stack:
 *   make up && make worker-dev    (second terminal)    && make e2e-stack
 * The worker runs in workerd (wrangler dev) and forwards to the API's internal route with the
 * shared secret; from there the event takes the normal path: PostgreSQL, the outbox, RabbitMQ,
 * the delivery worker and the mock receiver.
 */
import { expect, test } from '@playwright/test'
import {
  createApiKeyViaApi,
  createEndpointViaApi,
  PASSWORD,
  receivedFor,
  registerViaApi,
  signatureIsValid,
  STACK,
  uniqueEmail,
} from './stack'

test('Scenario 4: ingestion through the Cloudflare Worker', async ({ page, request }) => {
  const health = await request.get(`${STACK.edge}/health`).catch(() => null)
  expect(health?.ok(), `the edge worker isn't reachable at ${STACK.edge}: run make worker-dev`).toBe(true)

  const email = uniqueEmail('e2e-edge')
  const owner = await registerViaApi(request, email)
  const endpoint = await createEndpointViaApi(request, owner.headers, `${STACK.receiverForWorker}/hooks/ok`)
  const apiKey = await createApiKeyViaApi(request, owner.headers)
  const auth = { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' }
  const send = (data: unknown, headers: Record<string, string> = {}) =>
    request.post(`${STACK.edge}/${endpoint.id}`, { headers: { ...auth, ...headers }, data })

  // 1. An event sent to the edge is accepted by the API behind it
  const idempotencyKey = `edge-${Date.now()}`
  const event = { event_type: 'order.created', data: { order_id: 'ORD-EDGE', amount: 42 } }
  const res = await send(event, { 'Idempotency-Key': idempotencyKey })
  expect(res.status()).toBe(202)
  const { event_id: eventId } = await res.json()
  expect(res.headers()['x-request-id']).toBeTruthy()

  // 2. It's delivered once, signed, with the payload the edge received
  await expect.poll(async () => (await receivedFor(request, eventId)).length, { timeout: 30_000 }).toBe(1)
  const [delivery] = await receivedFor(request, eventId)
  expect(JSON.parse(delivery.body)).toMatchObject({ id: eventId, type: 'order.created', data: { order_id: 'ORD-EDGE' } })
  expect(signatureIsValid(endpoint.signing_secret, delivery)).toBe(true)

  // 3. Idempotency works through the edge: same key and payload replays the same event
  const replay = await send(event, { 'Idempotency-Key': idempotencyKey })
  expect(replay.status()).toBe(200)
  expect(replay.headers()['idempotent-replayed']).toBe('true')
  expect((await replay.json()).event_id).toBe(eventId)

  // 4. Bad requests are rejected at the edge, in the API's error format
  const rejected: [string, Promise<import('@playwright/test').APIResponse>, number, string][] = [
    ['no API key', request.post(`${STACK.edge}/${endpoint.id}`, { headers: { 'Content-Type': 'application/json' }, data: event }), 401, 'API_KEY_MISSING'],
    ['malformed API key', send(event, { Authorization: 'Bearer not-a-key' }), 401, 'API_KEY_INVALID'],
    ['not JSON', request.post(`${STACK.edge}/${endpoint.id}`, { headers: { ...auth, 'Content-Type': 'text/plain' }, data: 'hi' }), 415, 'UNSUPPORTED_MEDIA_TYPE'],
    ['missing event_type', send({ data: {} }), 422, 'VALIDATION_ERROR'],
    ['over 256 KB', send({ event_type: 'big.event', data: { blob: 'x'.repeat(300 * 1024) } }), 413, 'PAYLOAD_TOO_LARGE'],
    ['not an endpoint path', request.post(`${STACK.edge}/not-a-uuid`, { headers: auth, data: event }), 404, 'NOT_FOUND'],
  ]
  for (const [label, pending, status, code] of rejected) {
    const r = await pending
    expect(r.status(), label).toBe(status)
    expect((await r.json()).error.code, label).toBe(code)
  }

  // 5. The API's own checks still apply behind the edge: another user's key gets a 404
  const stranger = await registerViaApi(request, uniqueEmail('e2e-edge-stranger'))
  const strangerKey = await createApiKeyViaApi(request, stranger.headers)
  const foreign = await send(event, { Authorization: `Bearer ${strangerKey}` })
  expect(foreign.status()).toBe(404)

  // 6. Only the one accepted event exists: nothing rejected above reached the database
  const events = await (await request.get('/api/v1/events', { headers: owner.headers })).json()
  expect(events.items.map((e: { id: string }) => e.id)).toEqual([eventId])

  // 7. The dashboard shows the edge-ingested event as delivered
  await page.goto('/login')
  await page.getByLabel('Email').fill(email)
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD)
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect(page).toHaveURL(/\/dashboard$/)
  await page.goto(`/events/${eventId}`)
  await expect(page.getByRole('button', { name: /Attempt 1: HTTP 200/ })).toBeVisible({ timeout: 15_000 })
})
