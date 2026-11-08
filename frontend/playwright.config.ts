import { defineConfig, devices } from '@playwright/test'

const PORT = 4174
const executablePath = process.env.PW_CHROMIUM_PATH || undefined

/**
 * E2E runs against the Vite dev server with the mock API, so it needs no
 * backend. Point PLAYWRIGHT_BASE_URL at a full stack to run the same specs live.
 */
export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: true,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL ?? `http://localhost:${PORT}`,
    trace: 'retain-on-failure',
    launchOptions: { executablePath },
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } },
    { name: 'tablet', use: { ...devices['Desktop Chrome'], viewport: { width: 820, height: 1180 } } },
    { name: 'mobile', use: { ...devices['Desktop Chrome'], viewport: { width: 375, height: 812 }, hasTouch: true } },
  ],
  webServer: process.env.PLAYWRIGHT_BASE_URL
    ? undefined
    : {
        command: `npm run dev:mock -- --port ${PORT} --strictPort`,
        port: PORT,
        reuseExistingServer: !process.env.CI,
      },
})
