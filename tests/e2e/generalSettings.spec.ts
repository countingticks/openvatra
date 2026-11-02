import { readFile } from 'fs/promises'
import { join } from 'path'
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import type { Api } from '../../src/shared/ipc'
import { appArgs, createUserDataDir, removeUserDataDir } from './testProfile'

let app: ElectronApplication
let mainWindow: Page
let userDataDir: string
let exited = false

// These callbacks run inside the app's page, where the preload put the API on `window`.
type WithApi = typeof globalThis & { api: Api }

async function settingsOnDisk(): Promise<unknown> {
  return readFile(join(userDataDir, 'settings.json'), 'utf8').then(JSON.parse, () => null)
}

test.beforeAll(async () => {
  userDataDir = await createUserDataDir()
  app = await electron.launch({ args: appArgs(userDataDir) })
  app.on('close', () => (exited = true))
  mainWindow = await app.firstWindow()
  // A click waits for the button to exist; a key press right after launch can land before React listens.
  await mainWindow.getByRole('button', { name: 'Settings' }).click()
})

test.afterAll(async () => {
  if (!exited) await app.close()
  await removeUserDataDir(userDataDir)
})

test('Settings shows where this profile keeps its settings and logs', async () => {
  const locations = await mainWindow.evaluate(() => (window as WithApi).api.files.locations())

  expect(locations.settingsFile).toBe(join(userDataDir, 'settings.json'))
  await expect(mainWindow.getByText(locations.settingsFile)).toBeVisible()
  await expect(mainWindow.getByText(locations.logsFolder)).toBeVisible()
})

test('main refuses to open anything but its own folders', async () => {
  // Without the UI's guard rails: the request a compromised page could send.
  const attempt = mainWindow.evaluate(() =>
    (window as WithApi).api.files.openFolder('C:\\Windows' as unknown as 'logs')
  )

  await expect(attempt).rejects.toThrow(/unknown folder/i)
})

test('with "Quit OpenVatra" chosen, closing the window quits the app', async () => {
  await mainWindow.getByRole('radio', { name: 'Quit OpenVatra' }).click()
  await expect.poll(settingsOnDisk).toMatchObject({ closeAction: 'quit' })

  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close())

  // The whole app goes away, not just the window.
  await expect.poll(() => exited, { timeout: 15_000 }).toBe(true)
})
