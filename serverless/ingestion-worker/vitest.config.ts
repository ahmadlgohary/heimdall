import { cloudflareTest } from '@cloudflare/vitest-plugin'
import { defineConfig } from 'vitest/config'

// Tests run inside workerd (the Workers runtime) via Miniflare.
export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.toml' },
      miniflare: {
        bindings: {
          WORKER_SHARED_SECRET: 'test-worker-secret',
          API_ORIGIN: 'https://api.test',
        },
      },
    }),
  ],
})
