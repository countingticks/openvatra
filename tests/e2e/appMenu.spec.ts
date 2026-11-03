import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import type { Api } from '../../src/shared/ipc'
import { appArgs, createUserDataDir, removeUserDataDir } from './testProfile'

let app: ElectronApplication
let mainWindow: Page
let userDataDir: string
let exited = false

// These callbacks run inside the app's page, where the preload put the API on `window`.
type WithApi = typeof globalThis & { api: Api }

test.beforeAll(async () => {
  userDataDir = await createUserDataDir()
  app = await electron.launch({ args: appArgs(userDataDir) })
  app.on('close', () => (exited = true))
  mainWindow = await app.firstWindow()
  await mainWindow.getByRole('button', { name: 'Menu' }).waitFor()
})

test.afterAll(async () => {
  if (!exited) await app.close()
  await removeUserDataDir(userDataDir)
})

const menu = (): ReturnType<Page['getByRole']> => mainWindow.getByRole('menu', { name: 'Menu' })

test('Alt reaches our menu: Electron has no menu of its own any more', async () => {
  expect(await app.evaluate(({ Menu }) => Menu.getApplicationMenu())).toBeNull()

  await mainWindow.keyboard.press('Alt')

  await expect(menu()).toBeVisible()
})

test('a click outside closes the menu', async () => {
  await expect(menu()).toBeVisible()

  await mainWindow.mouse.click(700, 500)

  await expect(menu()).toBeHidden()
})

test('main refuses an edit command that is not on the list', async () => {
  const attempt = mainWindow.evaluate(() =>
    (window as WithApi).api.appWindow.edit('reload' as unknown as 'copy')
  )

  await expect(attempt).rejects.toThrow(/unknown edit command/i)
})

test('File → Quit OpenVatra ends the app, even though closing would only hide it', async () => {
  await mainWindow.getByRole('button', { name: 'Menu' }).click()
  await menu().getByRole('menuitem', { name: 'File' }).click()
  await mainWindow
    .getByRole('menu', { name: 'File' })
    .getByRole('menuitem', { name: /Quit OpenVatra/ })
    .click()

  await expect.poll(() => exited, { timeout: 15_000 }).toBe(true)
})
