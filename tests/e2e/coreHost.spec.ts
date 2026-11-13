import { execFile } from 'child_process'
import { readFile } from 'fs/promises'
import { join } from 'path'
import { promisify } from 'util'
import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test'
import type { Api } from '../../src/shared/ipc'
import { appArgs, createUserDataDir, removeUserDataDir } from './testProfile'

type WithApi = typeof globalThis & { api: Api }

let userDataDir: string

test.beforeAll(async () => {
  userDataDir = await createUserDataDir()
})

test.afterAll(async () => {
  await removeUserDataDir(userDataDir)
})

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

test('quitting the app stops core and removes its core.json', async () => {
  const app = await electron.launch({ args: appArgs(userDataDir) })
  const mainWindow = await app.firstWindow()
  await expect
    .poll(() => mainWindow.evaluate(async () => (await (window as WithApi).api.core.getState()).status), {
      timeout: 20_000
    })
    .toBe('ready')

  const discoveryFile = join(userDataDir, 'data', 'core.json')
  const { pid } = JSON.parse(await readFile(discoveryFile, 'utf8')) as { pid: number }
  expect(isRunning(pid)).toBe(true)

  await app.close()

  await expect
    .poll(
      () =>
        readFile(discoveryFile).then(
          () => 'present',
          () => 'gone'
        ),
      { timeout: 10_000 }
    )
    .toBe('gone')
  await expect.poll(() => isRunning(pid), { timeout: 10_000 }).toBe(false)
})

test('a killed app leaves core running and the next launch attaches to the same core', async () => {
  const dir = await createUserDataDir()
  const env = { ...process.env, OPENVATRA_E2E_KEEP_CORE: '1' } as Record<string, string>
  const discoveryFile = join(dir, 'data', 'core.json')
  const readDiscovery = async (): Promise<{ pid: number; port: number; token: string }> =>
    JSON.parse(await readFile(discoveryFile, 'utf8')) as { pid: number; port: number; token: string }
  const waitReady = async (app: ElectronApplication): Promise<void> => {
    const win = await app.firstWindow()
    await expect
      .poll(() => win.evaluate(async () => (await (window as WithApi).api.core.getState()).status), {
        timeout: 20_000
      })
      .toBe('ready')
  }

  let second: ElectronApplication | undefined
  try {
    const first = await electron.launch({ args: appArgs(dir), env })
    await waitReady(first)
    const before = await readDiscovery()

    // /t takes the Chromium helpers too: killing only the main process leaves them holding the profile open.
    // Core is not in that tree: it was started detached, and its launcher has already exited.
    await promisify(execFile)('taskkill', ['/pid', String(first.process().pid), '/t', '/f'])
    const res = await fetch(`http://127.0.0.1:${before.port}/health`, {
      headers: { Authorization: `Bearer ${before.token}` }
    })
    expect(res.status).toBe(200)

    second = await electron.launch({ args: appArgs(dir), env })
    await waitReady(second)
    expect((await readDiscovery()).pid).toBe(before.pid)
  } finally {
    await second?.close().catch(() => undefined)
    await promisify(execFile)(join('resources', 'core', 'core.exe'), [
      '--stop',
      '--data-dir',
      join(dir, 'data')
    ])
    await removeUserDataDir(dir)
  }
})
