import { expect, test, type Page } from '@playwright/test'

const DEMO = { email: 'demo@heimdall.dev', password: 'DemoPassword123' }

async function signIn(page: Page) {
  await page.goto('/login')
  await page.getByLabel('Email').fill(DEMO.email)
  await page.getByLabel('Password', { exact: true }).fill(DEMO.password)
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect(page).toHaveURL(/\/dashboard$/)
}

/** A regular account. The mock API lives in page memory, so stay in-app (no page.goto) afterwards. */
async function registerAndOpenAddEndpoint(page: Page) {
  await page.goto('/register')
  await page.getByLabel('Email').fill(`e2e-${Date.now()}@example.com`)
  await page.getByLabel('Password', { exact: true }).fill('E2e-Mock-Passw0rd')
  await page.getByLabel('Confirm password').fill('E2e-Mock-Passw0rd')
  await page.getByRole('button', { name: 'Create account' }).click()
  await expect(page).toHaveURL(/\/dashboard$/)
  await page.getByRole('link', { name: 'Add an endpoint' }).click()
  return page.getByRole('dialog', { name: 'Add endpoint' })
}

async function expectNoHorizontalOverflow(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
  expect(overflow).toBeLessThanOrEqual(0)
}

test('protected pages redirect to login', async ({ page }) => {
  await page.goto('/events')
  await expect(page).toHaveURL(/\/login$/)
})

test('dashboard renders live data without horizontal overflow', async ({ page }) => {
  await signIn(page)
  await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible()
  await expect(page.getByRole('list', { name: 'Recent deliveries over time' })).toBeVisible()
  await expect(page.getByText('Events received')).toBeVisible()
  await expectNoHorizontalOverflow(page)
})

for (const path of ['/endpoints', '/events', '/analytics', '/settings', '/settings/api-keys']) {
  test(`${path} fits the viewport`, async ({ page }) => {
    await signIn(page)
    await page.goto(path)
    await page.waitForLoadState('networkidle')
    await expectNoHorizontalOverflow(page)
  })
}

test('navigation works from the keyboard and the mobile drawer', async ({ page, viewport }) => {
  await signIn(page)
  const narrow = (viewport?.width ?? 1440) < 1024
  if (narrow) {
    await page.getByRole('button', { name: 'Open navigation' }).click()
    const drawer = page.getByRole('dialog', { name: 'Navigation' })
    await expect(drawer).toBeVisible()
    await drawer.getByRole('link', { name: 'Events' }).click()
    await expect(drawer).toBeHidden()
  } else {
    await page.getByRole('link', { name: 'Events' }).first().focus()
    await page.keyboard.press('Enter')
  }
  await expect(page).toHaveURL(/\/events$/)
  await expect(page.getByRole('heading', { name: 'Events', level: 1 })).toBeVisible()
})

test('send a test event and follow it to delivery', async ({ page }) => {
  // a regular account: the demo account is read-only
  const dialog = await registerAndOpenAddEndpoint(page)
  await dialog.getByLabel('Name').fill('Orders')
  await dialog.getByLabel('Destination URL').fill('https://hooks.example.com/orders')
  await dialog.getByRole('button', { name: 'Add endpoint' }).click()
  await page.getByRole('button', { name: 'I’ve saved the secret' }).click()
  await page.getByRole('link', { name: 'Orders' }).first().click()
  await page.getByRole('button', { name: 'Send test event' }).click()
  await page.getByRole('button', { name: 'View' }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'heimdall.test' })).toBeVisible()
  // polling advances the delivery from queued to a final state
  await expect(page.getByRole('list', { name: 'Attempts for execution 1' })).toBeVisible({ timeout: 15_000 })
  await expectNoHorizontalOverflow(page)
})

test('the demo account is read-only', async ({ page }) => {
  await signIn(page)
  await page.goto('/endpoints')
  await expect(page.getByText('Read-only demo.')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Add endpoint' })).toBeDisabled()
  await page.getByRole('link', { name: 'Production orders' }).first().click()
  await expect(page.getByRole('button', { name: 'Send test event' })).toBeDisabled()
  await expect(page.getByRole('button', { name: 'Delete endpoint' })).toBeDisabled()
  await expectNoHorizontalOverflow(page)
})

test('create endpoint dialog fits small screens', async ({ page }) => {
  const dialog = await registerAndOpenAddEndpoint(page)
  await expect(dialog).toBeVisible()
  const box = await dialog.boundingBox()
  const vp = page.viewportSize()!
  expect(box!.width).toBeLessThanOrEqual(vp.width)
  expect(box!.height).toBeLessThanOrEqual(vp.height)
})
