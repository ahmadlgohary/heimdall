import { expect, test, type Page } from '@playwright/test'

const DEMO = { email: 'demo@heimdall.dev', password: 'DemoPassword123' }

async function signIn(page: Page) {
  await page.goto('/login')
  await page.getByLabel('Email').fill(DEMO.email)
  await page.getByLabel('Password', { exact: true }).fill(DEMO.password)
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect(page).toHaveURL(/\/dashboard$/)
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
  await signIn(page)
  await page.goto('/endpoints')
  await page.getByRole('link', { name: 'Production orders' }).first().click()
  await page.getByRole('button', { name: 'Send test event' }).click()
  await page.getByRole('button', { name: 'View' }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'heimdall.test' })).toBeVisible()
  // polling advances the delivery from queued to a final state
  await expect(page.getByRole('list', { name: 'Attempts for execution 1' })).toBeVisible({ timeout: 15_000 })
  await expectNoHorizontalOverflow(page)
})

test('create endpoint dialog fits small screens', async ({ page }) => {
  await signIn(page)
  await page.goto('/endpoints?new=1')
  const dialog = page.getByRole('dialog', { name: 'Add endpoint' })
  await expect(dialog).toBeVisible()
  const box = await dialog.boundingBox()
  const vp = page.viewportSize()!
  expect(box!.width).toBeLessThanOrEqual(vp.width)
  expect(box!.height).toBeLessThanOrEqual(vp.height)
})
