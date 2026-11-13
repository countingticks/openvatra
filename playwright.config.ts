import { defineConfig } from '@playwright/test'

// electron.launch passes this process's environment on, so every e2e app sees it: its core gets --parent-pid and
// exits with that Electron, and a killed or failed test leaves no core running.
process.env.OPENVATRA_E2E = '1'

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
