// Runs the pre-commit checks and prints one line per passing step; only a failing step prints its output.
// Short output keeps the terminal readable and costs an AI agent far fewer tokens than the full logs.
//
//   npm run check                         format check, Go format/vet/tests, typecheck, lint, all unit tests
//   npm run check -- tests/unit/foo       same, but only the unit tests under the given paths
//   npm run check -- --e2e                all of the above, then build the app and run every end-to-end test
//   npm run check -- tests/e2e/a.spec.ts  the checks, then build and run only the given end-to-end specs
import { spawnSync } from 'node:child_process'

const args = process.argv.slice(2)
const e2ePaths = args.filter((arg) => arg.replaceAll('\\', '/').startsWith('tests/e2e'))
const withE2e = args.includes('--e2e') || e2ePaths.length > 0
const testPaths = args.filter((arg) => arg !== '--e2e' && !e2ePaths.includes(arg))

// Step = [name, command, options]. gofmt -l exits 0 and just lists unformatted files, so any output is a failure.
const steps = [
  ['format', 'npx prettier --check . --log-level warn'],
  ['typecheck', 'npm run typecheck --silent'],
  ['lint', 'npm run lint --silent'],
  ['gofmt', 'gofmt -l core', { failsOnOutput: true }],
  ['govet', 'go vet ./...', { cwd: 'core' }],
  ['gotest', 'go test ./...', { cwd: 'core' }],
  ['test', `npx vitest run --reporter=dot ${testPaths.join(' ')}`.trim()]
]
if (withE2e) {
  // Building and launching the app takes minutes, and a broken build fails every test the same way,
  // so these only run when everything before them passed.
  steps.push(
    [
      'build',
      'npm run fetch:llama --silent && npm run build:core --silent && npx electron-vite build',
      { needsPass: true }
    ],
    ['e2e', `npx playwright test --reporter=dot ${e2ePaths.join(' ')}`.trim(), { needsPass: true }]
  )
}

let failed = false
for (const [name, command, options = {}] of steps) {
  if (options.needsPass && failed) {
    console.log(`skip ${name} (an earlier step failed)`)
    continue
  }
  const started = Date.now()
  const result = spawnSync(command, {
    shell: true,
    encoding: 'utf8',
    cwd: options.cwd ?? process.cwd(),
    // Tells tests/setup.ts to keep failed-query errors short (see there).
    env: { ...process.env, CHECK_QUIET: '1' }
  })
  const seconds = ((Date.now() - started) / 1000).toFixed(1)
  if (result.status === 0 && !(options.failsOnOutput && result.stdout.trim())) {
    console.log(`ok   ${name} (${seconds}s)`)
    continue
  }
  failed = true
  console.log(`FAIL ${name} (${seconds}s): ${command}`)
  // The end of a log holds the summary and the errors; long logs are cut to their last 60 lines.
  const lines = `${result.stdout}${result.stderr}`.trimEnd().split('\n')
  console.log(lines.slice(-60).join('\n'))
}

process.exit(failed ? 1 : 0)
