// Builds core.exe. A dev core outlives `npm run dev` (it runs detached), so it first asks a running one on the
// default data folder to stop: otherwise Windows keeps the exe locked, or the next shell attaches to the old build
// (same exe path and arguments, so the same fingerprint).
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

const exePath = join('resources', 'core', 'core.exe')

if (existsSync(exePath) && process.env.APPDATA) {
  // Exit code ignored: no core.json, or one left by a core that is gone, is the normal case.
  spawnSync(exePath, ['--stop', '--data-dir', join(process.env.APPDATA, 'OpenVatra', 'data')], {
    stdio: 'inherit'
  })
}

const build = spawnSync('go', ['build', '-C', 'core', '-o', '../resources/core/core.exe', '.'], {
  stdio: 'inherit'
})
process.exit(build.status ?? 1)
