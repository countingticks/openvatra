import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { appArgs, createUserDataDir, removeUserDataDir } from './testProfile'

let app: ElectronApplication
let mainWindow: Page
let userDataDir: string

test.beforeAll(async () => {
  userDataDir = await createUserDataDir()
  app = await electron.launch({ args: appArgs(userDataDir) })
  mainWindow = await app.firstWindow()
  await mainWindow.getByRole('navigation', { name: 'Main' }).waitFor()
})

test.afterAll(async () => {
  await app.close()
  await removeUserDataDir(userDataDir)
})

/**
 * Presses Ctrl+B and returns the sidebar's width 60 ms later, a quarter into the 240 ms slide: mid-way if it
 * animates, already final if not. (One frame is too early: a transition's first frame only records its start.)
 */
const widthSoonAfterToggle = (): Promise<number> =>
  mainWindow.evaluate(
    () =>
      new Promise<number>((resolve) => {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'b', ctrlKey: true }))
        setTimeout(() => resolve(document.getElementById('sidebar')?.getBoundingClientRect().width ?? -1), 60)
      })
  )

test('Animations Off: the sidebar closes and opens at once, without sliding', async () => {
  await mainWindow.keyboard.press('Control+,')
  const settings = mainWindow.getByRole('dialog', { name: 'Settings' })
  await settings.getByRole('radiogroup', { name: 'Animations' }).getByRole('radio', { name: 'Off' }).click()
  await expect(mainWindow.locator('html')).toHaveAttribute('data-motion', 'reduce')
  await mainWindow.keyboard.press('Escape')
  await expect(settings).toBeHidden()

  expect(await widthSoonAfterToggle()).toBe(0)
  expect(await widthSoonAfterToggle()).toBe(224)
})

test('Animations On: the sidebar slides (60 ms in, it is still on its way)', async () => {
  await mainWindow.keyboard.press('Control+,')
  const settings = mainWindow.getByRole('dialog', { name: 'Settings' })
  await settings.getByRole('radiogroup', { name: 'Animations' }).getByRole('radio', { name: 'On' }).click()
  await expect(mainWindow.locator('html')).toHaveAttribute('data-motion', 'full')
  await mainWindow.keyboard.press('Escape')
  await expect(settings).toBeHidden()

  const width = await widthSoonAfterToggle()
  expect(width).toBeGreaterThan(0)
  expect(width).toBeLessThan(224)
})
