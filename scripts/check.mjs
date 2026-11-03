// Runs the pre-commit checks and prints one line per passing step; only a failing step prints its output.
// Short output keeps the terminal readable and costs an AI agent far fewer tokens than the full logs.
//
//   npm run check                       format check, Go format/vet/tests, typecheck, lint, all unit tests
//   npm run check -- tests/unit/foo     same, but only the unit tests under the given paths
import { spawnSync } from 'node:child_process'

const testPaths = process.argv.slice(2)

const steps = [
  ['format', 'npx prettier --check . --log-level warn'],
  ['typecheck', 'npm run typecheck --silent'],
  ['lint', 'npm run lint --silent'],
  ['gofmt', 'gofmt -l core', true],
  ['govet', 'go vet ./...', false, 'core'],
  ['gotest', 'go test ./...', false, 'core'],
  ['test', `npx vitest run --reporter=dot ${testPaths.join(' ')}`.trim()]
]

let failed = false
// Step = [name, command, failsOnOutput, cwd]. gofmt -l exits 0 and just lists unformatted files, so any output is a failure.
for (const [name, command, failsOnOutput = false, cwd = process.cwd()] of steps) {
  const started = Date.now()
  const result = spawnSync(command, { shell: true, encoding: 'utf8', cwd })
  const seconds = ((Date.now() - started) / 1000).toFixed(1)
  if (result.status === 0 && !(failsOnOutput && result.stdout.trim())) {
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
