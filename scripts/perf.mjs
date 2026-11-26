// Builds the app with readable function names, then runs the perf scenarios (tests/perf) on throwaway profiles.
//
//   npm run perf -- [--scenario <name>]... [--matrix] [--model <gguf>] [--placement <p>] [--duration <s>]
//                   [--trace] [--no-build]
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

const usage =
  'usage: npm run perf -- [--scenario <name>]... [--matrix] [--model <gguf path>] ' +
  '[--placement <auto|gpu|experts|layers|cpu>] [--duration <s>] [--trace] [--no-build]'
const placements = ['auto', 'gpu', 'experts', 'layers', 'cpu']

const args = process.argv.slice(2)
const names = []
let model = ''
let placement = ''
let duration = 15
let trace = false
let build = true
let matrix = false
let problem = ''
for (let i = 0; i < args.length && !problem; i++) {
  const arg = args[i]
  if (arg === '--help') {
    console.log(usage)
    process.exit(0)
  } else if (arg === '--trace') trace = true
  else if (arg === '--no-build') build = false
  else if (arg === '--matrix') matrix = true
  else if (['--scenario', '--model', '--placement', '--duration'].includes(arg)) {
    const value = args[++i]
    if (value === undefined || value.startsWith('--')) problem = `${arg} needs a value`
    else if (arg === '--scenario') names.push(value)
    else if (arg === '--model') model = resolve(value)
    else if (arg === '--placement') {
      placement = value
      if (!placements.includes(value)) problem = `--placement must be one of ${placements.join(', ')}`
    } else {
      duration = Number(value)
      if (!Number.isFinite(duration) || duration <= 0) problem = '--duration must be a positive number'
    }
  } else problem = `unknown option ${arg}`
}
if (problem) {
  console.log(problem)
  console.log(usage)
  process.exit(1)
}

if (build) {
  console.log('building (unminified renderer)…')
  const built = spawnSync('npx electron-vite build', {
    shell: true,
    encoding: 'utf8',
    env: { ...process.env, PERF_BUILD: '1' }
  })
  if (built.status !== 0) {
    console.log(`${built.stdout}${built.stderr}`.trimEnd().split('\n').slice(-40).join('\n'))
    process.exit(1)
  }
} else if (!existsSync('out/main/index.js')) {
  console.log('run `npm run perf` without --no-build first')
  process.exit(1)
}

const run = spawnSync('npx playwright test -c playwright.perf.config.ts', {
  shell: true,
  stdio: 'inherit',
  env: {
    ...process.env,
    PERF_SCENARIOS: matrix ? '' : names.join(','),
    PERF_MODEL: model,
    PERF_PLACEMENT: placement,
    PERF_DURATION: String(duration),
    ...(trace ? { PERF_TRACE: '1' } : {})
  }
})
process.exit(run.status ?? 1)
