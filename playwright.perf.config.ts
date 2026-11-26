import { defineConfig } from '@playwright/test'

// electron.launch passes this process's environment on, so every perf app sees it: its core gets --parent-pid and
// exits with that Electron, and a killed or failed scenario leaves no core running.
process.env.OPENVATRA_E2E = '1'

// Perf scenarios launch the built app (out/); `npm run perf` builds it unminified first. Run on their own: they
// measure, they never assert a number.
export default defineConfig({
  testDir: 'tests/perf',
  // Each scenario sets its own timeout, from its measured window.
  workers: 1,
  fullyParallel: false,
  retries: 0,
  outputDir: 'test-results/perf-artifacts',
  reporter: [['list'], ['./tests/perf/reporter.ts']]
})
