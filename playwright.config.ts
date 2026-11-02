import { defineConfig } from '@playwright/test'

// End-to-end tests launch the built Electron app (out/), so run `electron-vite build` first
// (`npm run test:e2e` does both).
export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 30_000,
  // Electron apps share one display and user profile; run tests one at a time.
  workers: 1,
  fullyParallel: false,
  // On CI, retry a failed test once and keep a trace of the retry to see what happened.
  retries: process.env.CI ? 1 : 0,
  forbidOnly: !!process.env.CI,
  reporter: process.env.CI ? [['github'], ['list']] : 'list',
  use: {
    trace: 'on-first-retry'
  }
})
