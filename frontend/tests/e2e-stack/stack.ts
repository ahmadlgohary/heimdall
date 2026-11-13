/**
 * Helpers for the end-to-end scenarios that run against the real docker compose stack
 * (plan §11.5): frontend → API → PostgreSQL → RabbitMQ → worker → mock receiver.
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { expect, type APIRequestContext, type Page } from '@playwright/test'

/** Read ports and broker credentials from the repo's .env, like docker compose does. */
function rootEnv(): Record<string, string> {
  const file = path.resolve(import.meta.dirname, '../../../.env')
  if (!fs.existsSync(file)) return {}
  return Object.fromEntries(
    fs
      .readFileSync(file, 'utf8')
      .split('\n')
      .map((l) => l.match(/^([A-Z0-9_]+)=(.*)$/))
      .filter((m): m is RegExpMatchArray => !!m && m[2] !== '')
      .map((m) => [m[1], m[2]]),
  )
}

const env = { ...rootEnv(), ...process.env } as Record<string, string | undefined>
const port = (name: string, fallback: number) => Number(env[name] || fallback)

export const STACK = {
  frontend: env.STACK_URL ?? `http://localhost:${port('FRONTEND_PORT', 8080)}`,
  receiver: env.RECEIVER_URL ?? `http://localhost:${port('MOCK_RECEIVER_PORT', 9000)}`,
  rabbitmq: env.RABBITMQ_MGMT_URL ?? `http://localhost:${port('RABBITMQ_MANAGEMENT_PORT', 15672)}`,
  rabbitUser: env.RABBITMQ_USER ?? 'heimdall',
  rabbitPassword: env.RABBITMQ_PASSWORD ?? 'heimdall',
  /** the broker's virtual host: "/" locally; CloudAMQP uses one named after the user */
  rabbitVhost: env.RABBITMQ_VHOST ?? '/',
  /** how the *worker* reaches the receiver, inside the docker network */
  receiverForWorker: env.RECEIVER_URL_FOR_WORKER ?? 'http://mock-receiver:9000',
  /** the Cloudflare Worker in front of the API: `make worker-dev` serves it on :8787 */
  edge: env.EDGE_URL ?? 'http://localhost:8787',
}

export const PASSWORD = 'E2e-Stack-Passw0rd'

export function uniqueEmail(tag: string) {
  return `${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@example.com`
}

/* ---------- through the UI ---------- */

export async function registerInUi(page: Page, email: string) {
  await page.goto('/register')
  await page.getByLabel('Email').fill(email)
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD)
  await page.getByLabel('Confirm password').fill(PASSWORD)
  await page.getByRole('button', { name: 'Create account' }).click()
  await expect(page).toHaveURL(/\/dashboard$/)
}

/** Creates an endpoint in the UI. Returns its id and the signing secret shown once. */
export async function createEndpointInUi(page: Page, name: string, url: string) {
  await page.goto('/endpoints?new=1')
  const dialog = page.getByRole('dialog', { name: 'Add endpoint' })
  await dialog.getByLabel('Name').fill(name)
  await dialog.getByLabel('Destination URL').fill(url)
  await dialog.getByRole('button', { name: 'Add endpoint' }).click()
  const secret = (await page.getByTestId('secret-value').textContent())!.trim()
  expect(secret).toMatch(/^whsec_/)
  await page.getByRole('button', { name: 'I’ve saved the secret' }).click()
  await page.getByRole('link', { name }).first().click()
  await expect(page).toHaveURL(/\/endpoints\/[0-9a-f-]{36}$/)
  return { id: page.url().split('/').pop()!, secret }
}

export async function createApiKeyInUi(page: Page, name: string) {
  await page.goto('/settings/api-keys')
  await page.getByRole('button', { name: 'Create key' }).first().click()
  const dialog = page.getByRole('dialog', { name: 'Create API key' })
  await dialog.getByLabel('Name').fill(name)
  await dialog.getByRole('button', { name: 'Create key' }).click()
  const key = (await page.getByTestId('secret-value').textContent())!.trim()
  expect(key).toMatch(/^wh_live_/)
  await page.getByRole('button', { name: 'I’ve saved the key' }).click()
  return key
}

/* ---------- through the API (as a customer application would) ---------- */

export async function registerViaApi(request: APIRequestContext, email: string) {
  const res = await request.post('/api/v1/auth/register', { data: { email, password: PASSWORD } })
  expect(res.status()).toBe(201)
  const body = await res.json()
  return { id: body.user.id as string, headers: { Authorization: `Bearer ${body.access_token}` } }
}

export async function createEndpointViaApi(request: APIRequestContext, headers: Record<string, string>, url: string) {
  const res = await request.post('/api/v1/endpoints', { data: { name: 'E2E endpoint', url }, headers })
  expect(res.status()).toBe(201)
  return (await res.json()) as { id: string; signing_secret: string }
}

export async function createApiKeyViaApi(request: APIRequestContext, headers: Record<string, string>) {
  const res = await request.post('/api/v1/api-keys', { data: { name: 'e2e' }, headers })
  expect(res.status()).toBe(201)
  return (await res.json()).key as string
}

export async function ingest(request: APIRequestContext, endpointId: string, apiKey: string, data: unknown) {
  return request.post(`/api/v1/ingest/${endpointId}`, {
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    data: { event_type: 'order.created', data },
  })
}

/* ---------- receiver and broker ---------- */

export interface ReceivedDelivery {
  attempt: string
  timestamp: string
  signature: string
  body: string
}

export async function receivedFor(request: APIRequestContext, eventId: string): Promise<ReceivedDelivery[]> {
  const res = await request.get(`${STACK.receiver}/requests/${eventId}`)
  return res.ok() ? res.json() : []
}

export async function setReceiverSwitch(request: APIRequestContext, status: number) {
  const res = await request.post(`${STACK.receiver}/control/switch?status=${status}`)
  expect(res.ok()).toBeTruthy()
}

/** What a receiver does: HMAC-SHA256 over "{timestamp}.{raw body}" with the endpoint's secret. */
export function signatureIsValid(secret: string, delivery: ReceivedDelivery) {
  const expected = crypto.createHmac('sha256', secret).update(`${delivery.timestamp}.${delivery.body}`).digest('hex')
  const received = delivery.signature.replace(/^v1=/, '')
  return received.length === expected.length && crypto.timingSafeEqual(Buffer.from(received), Buffer.from(expected))
}

/** Messages acknowledged on the delivery queue, from the RabbitMQ management API. */
export async function deliveryQueueAcks(request: APIRequestContext): Promise<number> {
  const res = await request.get(`${STACK.rabbitmq}/api/queues/${encodeURIComponent(STACK.rabbitVhost)}/heimdall.deliveries`, {
    headers: {
      Authorization: `Basic ${Buffer.from(`${STACK.rabbitUser}:${STACK.rabbitPassword}`).toString('base64')}`,
    },
  })
  expect(res.ok(), `RabbitMQ management API at ${STACK.rabbitmq}`).toBeTruthy()
  const queue = await res.json()
  return queue.message_stats?.ack ?? 0
}
