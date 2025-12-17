import { defineConfig } from '@playwright/test'

const baseURL = process.env.E2E_BASE_URL || 'http://localhost:5173'

export default defineConfig({
  testDir: './tests',
  timeout: 60_000,
  workers: 1,
  use: {
    baseURL,
    headless: true,
  },
  // Keep it lean: assume the dev server is started separately (e.g., run_local_stack).
  // If you want Playwright to start it, set WEB_SERVER_COMMAND env and enable webServer here.
  // Keep it lean: assume the dev server is started separately (e.g., run_local_stack).
  // If you want Playwright to start it, set WEB_SERVER_COMMAND env and enable webServer here.
})
