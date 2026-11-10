/**
 * The three end-to-end scenarios from plan §11.5, against the real stack:
 *   make up && make e2e-stack
 * Nothing here is mocked: the browser drives the frontend container, events go through
 * the API, PostgreSQL, the outbox, RabbitMQ and the worker to the mock-receiver container.
 */
import { expect, test } from '@playwright/test'
import {
  createApiKeyInUi,
  createApiKeyViaApi,
  createEndpointInUi,
  createEndpointViaApi,
  deliveryQueueAcks,
  ingest,
  PASSWORD,
  receivedFor,
  registerInUi,
  registerViaApi,
  setReceiverSwitch,
  signatureIsValid,
  STACK,
  uniqueEmail,
} from './stack'

test.describe.configure({ mode: 'serial' }) // scenario 2 flips the shared receiver's switch

test('Scenario 1: successful delivery', async ({ page, request }) => {
  // 1. Register a new user
  await registerInUi(page, uniqueEmail('e2e-success'))

  // 2. Create an endpoint pointing to the local mock receiver
  const endpoint = await createEndpointInUi(page, 'Orders (e2e)', `${STACK.receiverForWorker}/hooks/ok`)
  const apiKey = await createApiKeyInUi(page, 'E2E key')
  const acksBefore = await deliveryQueueAcks(request)

  // 3. Submit an event using the API key, as the customer's application would
  const orderId = `ORD-${Date.now()}`
  const res = await ingest(request, endpoint.id, apiKey, { order_id: orderId, amount: 129.99 })
  expect(res.status()).toBe(202)
  const { event_id: eventId } = await res.json()

  // 4. The event appears in the dashboard
  await page.goto('/dashboard')
  const recent = page.getByRole('region', { name: 'Recent activity' })
  await expect(recent.getByRole('table').getByRole('link', { name: 'order.created' })).toBeVisible()

  // 5. RabbitMQ processed the job (the worker acked a message on the delivery queue)
  await expect.poll(() => deliveryQueueAcks(request), { timeout: 30_000 }).toBeGreaterThan(acksBefore)

  // 6. The receiver got the signed HTTP POST, and the signature verifies with the endpoint's secret
  await expect.poll(async () => (await receivedFor(request, eventId)).length, { timeout: 30_000 }).toBe(1)
  const [delivery] = await receivedFor(request, eventId)
  expect(delivery.attempt).toBe('1')
  expect(JSON.parse(delivery.body)).toMatchObject({ id: eventId, type: 'order.created', data: { order_id: orderId } })
  expect(signatureIsValid(endpoint.secret, delivery)).toBe(true)
  expect(signatureIsValid('whsec_wrong-secret', delivery)).toBe(false)

  // 7. The dashboard reports the successful delivery
  await page.reload()
  await expect(recent.getByRole('table').getByText('Delivered')).toBeVisible({ timeout: 15_000 })
  const delivered = page.locator('dl > div').filter({ has: page.getByText('Delivered', { exact: true }) })
  await expect(delivered.locator('dd')).toHaveText('1')
  await page.goto(`/events/${eventId}`)
  await expect(page.getByRole('button', { name: /Attempt 1: HTTP 200/ })).toBeVisible()
})

test('Scenario 2: failed delivery and retry', async ({ page, request }) => {
  test.setTimeout(150_000) // the first retry waits the real 30 s backoff

  // 1. Register an endpoint that initially returns HTTP 500
  await setReceiverSwitch(request, 500)
  const email = uniqueEmail('e2e-retry')
  const owner = await registerViaApi(request, email)
  const endpoint = await createEndpointViaApi(request, owner.headers, `${STACK.receiverForWorker}/hooks/switch`)
  const apiKey = await createApiKeyViaApi(request, owner.headers)

  try {
    // 2. Submit a webhook event
    const res = await ingest(request, endpoint.id, apiKey, { order_id: 'ORD-RETRY' })
    expect(res.status()).toBe(202)
    const { event_id: eventId } = await res.json()

    await page.goto('/login')
    await page.getByLabel('Email').fill(email)
    await page.getByLabel('Password', { exact: true }).fill(PASSWORD)
    await page.getByRole('button', { name: 'Sign in', exact: true }).click()
    await expect(page).toHaveURL(/\/dashboard$/)
    await page.goto(`/events/${eventId}`)

    // 3. The first attempt fails
    await expect(page.getByRole('button', { name: /Attempt 1: HTTP 500/ })).toBeVisible({ timeout: 30_000 })
    // 4. The next retry is scheduled (status, countdown on the attempt trace)
    await expect(page.getByRole('heading', { level: 1 }).locator('..').getByText('Retrying')).toBeVisible()
    await expect(page.getByText('Next retry')).toBeVisible()
    await expect(page.getByText(/^in \d+s$/)).toBeVisible()

    // 5. The receiver starts returning HTTP 200
    await setReceiverSwitch(request, 200)

    // 6. A subsequent attempt succeeds (the page updates by polling; no reload)
    await expect(page.getByRole('button', { name: /Attempt 2: HTTP 200/ })).toBeVisible({ timeout: 90_000 })
    await expect(page.getByRole('heading', { level: 1 }).locator('..').getByText('Delivered')).toBeVisible()

    // 7. The attempt history is preserved
    await expect(page.getByRole('button', { name: /Attempt 1: HTTP 500/ })).toBeVisible()
    const deliveries = await (await request.get(`/api/v1/events/${eventId}/deliveries`, { headers: owner.headers })).json()
    const attempts = await (
      await request.get(`/api/v1/deliveries/${deliveries.items[0].id}/attempts`, { headers: owner.headers })
    ).json()
    expect(attempts.items.map((a: { http_status: number }) => a.http_status)).toEqual([500, 200])
    const received = await receivedFor(request, eventId)
    expect(received.map((r) => r.attempt)).toEqual(['1', '2'])
    expect(received.every((r) => signatureIsValid(endpoint.signing_secret, r))).toBe(true)
  } finally {
    await setReceiverSwitch(request, 500) // leave the shared receiver as we found it
  }
})

test('Scenario 3: security and ownership', async ({ page, request }) => {
  // 1. Register two different users
  const alice = await registerViaApi(request, uniqueEmail('e2e-alice'))
  const bobEmail = uniqueEmail('e2e-bob')
  const bob = await registerViaApi(request, bobEmail)

  // 2. Create an endpoint (and an event) under user A
  const endpoint = await createEndpointViaApi(request, alice.headers, `${STACK.receiverForWorker}/hooks/ok`)
  const aliceKey = await createApiKeyViaApi(request, alice.headers)
  const { event_id: eventId } = await (await ingest(request, endpoint.id, aliceKey, { secret: 'alice-only' })).json()

  // 3–4. User B can't reach any of it: the API answers 404, never revealing it exists
  for (const [method, path] of [
    ['GET', `/api/v1/endpoints/${endpoint.id}`],
    ['PATCH', `/api/v1/endpoints/${endpoint.id}`],
    ['DELETE', `/api/v1/endpoints/${endpoint.id}`],
    ['POST', `/api/v1/endpoints/${endpoint.id}/rotate-secret`],
    ['POST', `/api/v1/endpoints/${endpoint.id}/test`],
    ['GET', `/api/v1/events/${eventId}`],
    ['GET', `/api/v1/events/${eventId}/payload`],
    ['POST', `/api/v1/events/${eventId}/replay`],
  ] as const) {
    const res = await request.fetch(path, { method, headers: bob.headers, data: method === 'PATCH' ? { name: 'x' } : undefined })
    expect(res.status(), `${method} ${path}`).toBe(404)
  }
  expect((await (await request.get('/api/v1/endpoints', { headers: bob.headers })).json()).items).toEqual([])
  expect((await (await request.get('/api/v1/events', { headers: bob.headers })).json()).items).toEqual([])

  // B's own API key can't send events to A's endpoint either
  const bobKey = await createApiKeyViaApi(request, bob.headers)
  expect((await ingest(request, endpoint.id, bobKey, {})).status()).toBe(404)

  // No token at all: 401
  expect((await request.get(`/api/v1/endpoints/${endpoint.id}`)).status()).toBe(401)

  // The UI shows B a not-found state, with none of A's data
  await page.goto('/login')
  await page.getByLabel('Email').fill(bobEmail)
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD)
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect(page).toHaveURL(/\/dashboard$/)
  await page.goto(`/endpoints/${endpoint.id}`)
  await expect(page.getByRole('alert')).toContainText('Not found')
  await page.goto(`/events/${eventId}`)
  await expect(page.getByRole('alert')).toContainText('Not found')
  await expect(page.getByText('alice-only')).toHaveCount(0)

  // A still has full access to their own endpoint
  expect((await request.get(`/api/v1/endpoints/${endpoint.id}`, { headers: alice.headers })).status()).toBe(200)
})
