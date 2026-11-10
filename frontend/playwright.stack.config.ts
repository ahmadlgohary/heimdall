import { defineConfig, devices } from '@playwright/test'
import { STACK } from './tests/e2e-stack/stack'

/**
 * End-to-end scenarios against a running docker compose stack (plan §11.5).
 *   make up && make e2e-stack
 * Unlike playwright.config.ts (mock API), nothing is mocked here.
 */
export default defineConfig({
  testDir: './tests/e2e-stack',
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: 90_000,
  reporter: process.env.CI ? [['github'], ['list']] : 'list',
  use: {
    baseURL: STACK.frontend,
    trace: 'retain-on-failure',
    launchOptions: { executablePath: process.env.PW_CHROMIUM_PATH || undefined },
    ...devices['Desktop Chrome'],
    viewport: { width: 1440, height: 900 },
  },
})
