import { readFile } from 'fs/promises'
import { join } from 'path'
import { _electron as electron, expect, test } from '@playwright/test'
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
