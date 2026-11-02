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

// Main saves the window's real bounds whenever it moves or resizes, including when Windows adjusts it right after
// launch (CI's small screen does). So these tests check the fields they're about, never the whole file as is.

test.beforeAll(async () => {
  userDataDir = await createUserDataDir()
  await launch()
})

test.afterAll(async () => {
  await app.close()
  await removeUserDataDir(userDataDir)
})

test('a first launch has the default settings', async () => {
  const settings = await mainWindow.evaluate(() => (window as WithApi).api.settings.get())
  // toEqual treats an undefined property as missing, so this ignores only the window bounds.
  expect({ ...settings, window: undefined }).toEqual(defaultSettings)
})

test('the UI can change a setting, and it is saved to disk', async () => {
  const updated = await mainWindow.evaluate(() => (window as WithApi).api.settings.update({ theme: 'dark' }))

  expect(updated.theme).toBe('dark')
  expect(await settingsOnDisk()).toMatchObject({ theme: 'dark' })
})

test('the UI cannot change what it does not own', async () => {
  const forbidden = { x: 0, y: 0, width: 4000, height: 4000 }

  const error = await mainWindow.evaluate(
    (bounds) =>
      (window as WithApi).api.settings
        // Bypasses the TypeScript type on purpose, as a compromised page would.
        .update({ window: bounds } as never)
        .then(
          () => null,
          (reason: Error) => reason.message
        ),
    forbidden
  )

  expect(error).toContain('Settings could not be updated')
  const current = await mainWindow.evaluate(() => (window as WithApi).api.settings.get())
  expect(current.window).not.toEqual(forbidden)
  expect(await settingsOnDisk()).not.toMatchObject({ window: forbidden })
  // The rest of the file is as the earlier test left it.
  expect(await settingsOnDisk()).toMatchObject({ theme: 'dark' })
})

test('settings survive a restart', async () => {
  await app.close()
  await launch()

  const settings = await mainWindow.evaluate(() => (window as WithApi).api.settings.get())
  expect(settings.theme).toBe('dark')
})
