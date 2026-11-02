import { readFile } from 'fs/promises'
import { join } from 'path'
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import type { Api } from '../../src/shared/ipc'
import { defaultSettings } from '../../src/shared/settings'
import { appArgs, createUserDataDir, removeUserDataDir } from './testProfile'

let app: ElectronApplication
let mainWindow: Page
let userDataDir: string

async function launch(): Promise<void> {
  app = await electron.launch({ args: appArgs(userDataDir) })
  mainWindow = await app.firstWindow()
}

async function settingsOnDisk(): Promise<unknown> {
  return JSON.parse(await readFile(join(userDataDir, 'settings.json'), 'utf8'))
}

// These callbacks run inside the app's page, where the preload put the API on `window`.
type WithApi = typeof globalThis & { api: Api }

test.beforeAll(async () => {
  userDataDir = await createUserDataDir()
  await launch()
})

test.afterAll(async () => {
  await app.close()
  await removeUserDataDir(userDataDir)
})

test('a first launch has the default settings', async () => {
  expect(await mainWindow.evaluate(() => (window as WithApi).api.settings.get())).toEqual(defaultSettings)
})

test('the UI can change a setting, and it is saved to disk', async () => {
  const updated = await mainWindow.evaluate(() => (window as WithApi).api.settings.update({ theme: 'dark' }))

  expect(updated).toEqual({ ...defaultSettings, theme: 'dark' })
  expect(await settingsOnDisk()).toEqual(updated)
})

test('the UI cannot change what it does not own', async () => {
  const before = await settingsOnDisk()

  const error = await mainWindow.evaluate(() =>
    (window as WithApi).api.settings
      // Bypasses the TypeScript type on purpose, as a compromised page would.
      .update({ window: { x: 0, y: 0, width: 4000, height: 4000 } } as never)
      .then(
        () => null,
        (reason: Error) => reason.message
      )
  )

  expect(error).toContain('Settings could not be updated')
  expect(await settingsOnDisk()).toEqual(before)
})

test('settings survive a restart', async () => {
  await app.close()
  await launch()

  const settings = await mainWindow.evaluate(() => (window as WithApi).api.settings.get())
  expect(settings.theme).toBe('dark')
})
