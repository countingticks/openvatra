import { readFile } from 'fs/promises'
import { join } from 'path'
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { startedAtLoginArg } from '../../src/main/autostart'
import type { Api } from '../../src/shared/ipc'
import { appArgs, createUserDataDir, removeUserDataDir } from './testProfile'

let app: ElectronApplication
let page: Page
let userDataDir: string

// These callbacks run inside the app's page, where the preload put the API on `window`.
type WithApi = typeof globalThis & { api: Api }

async function appLog(): Promise<string> {
  return readFile(join(userDataDir, 'logs', 'main.log'), 'utf8').catch(() => '')
}

test.beforeAll(async () => {
  userDataDir = await createUserDataDir()
  // Launched the way Windows starts it at login.
  app = await electron.launch({ args: [...appArgs(userDataDir), startedAtLoginArg] })
  page = await app.firstWindow()
  await page.waitForLoadState('load')
})

test.afterAll(async () => {
  await app.close()
  await removeUserDataDir(userDataDir)
})

test('started at login, the window loads but stays hidden in the tray', async () => {
  const visible = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible())
  expect(visible).toBe(false)
})

test('turning start with Windows on is applied, but never registers a build that is not installed', async () => {
  await page.evaluate(() => (window as WithApi).api.settings.update({ startWithWindows: true }))

  await expect.poll(appLog).toContain('Start with Windows on; not registered, the app is not installed')
})
