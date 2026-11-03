import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { appArgs, createUserDataDir, removeUserDataDir } from './testProfile'

let app: ElectronApplication
let mainWindow: Page
let userDataDir: string

test.beforeAll(async () => {
  userDataDir = await createUserDataDir()
  app = await electron.launch({ args: appArgs(userDataDir) })
  mainWindow = await app.firstWindow()
  await mainWindow.getByRole('banner').waitFor()
})

test.afterAll(async () => {
  await app.close()
  await removeUserDataDir(userDataDir)
})

const isMaximized = (): Promise<boolean> =>
  app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isMaximized())

test('has no native title bar: the page fills the whole window', async () => {
  const heights = await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0]
    return { window: window.getBounds().height, content: window.getContentBounds().height }
  })

  expect(heights.content).toBe(heights.window)
})

test('keeps the sidebar clear of the title bar', async () => {
  const bar = await mainWindow.getByRole('banner').boundingBox()
  const firstTab = await mainWindow
    .getByRole('navigation', { name: 'Main' })
    .getByRole('button')
    .first()
    .boundingBox()

  expect(bar && firstTab && firstTab.y >= bar.y + bar.height).toBe(true)
})

test('maximizes and restores from its own button, and the label follows', async () => {
  await mainWindow.getByRole('button', { name: 'Maximize' }).click()
  await expect.poll(isMaximized).toBe(true)
  await expect(mainWindow.getByRole('button', { name: 'Restore' })).toBeVisible()

  await mainWindow.getByRole('button', { name: 'Restore' }).click()
  await expect.poll(isMaximized).toBe(false)
  await expect(mainWindow.getByRole('button', { name: 'Maximize' })).toBeVisible()
})

test('follows a maximize it did not cause', async () => {
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].maximize())
  await expect(mainWindow.getByRole('button', { name: 'Restore' })).toBeVisible()

  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].unmaximize())
  await expect(mainWindow.getByRole('button', { name: 'Maximize' })).toBeVisible()
})

test('Close does what closing the window does: hides it to the tray by default', async () => {
  await mainWindow.getByRole('button', { name: 'Close' }).click()

  await expect
    .poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible()))
    .toBe(false)
})
