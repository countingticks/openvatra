import { readFile } from 'fs/promises'
import { join } from 'path'
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { appArgs, createUserDataDir, removeUserDataDir } from './testProfile'

let app: ElectronApplication
let mainWindow: Page
let userDataDir: string

async function launch(): Promise<void> {
  // Playwright pins pages to a light prefers-color-scheme by default; null lets the page see what the app sets.
  app = await electron.launch({ args: appArgs(userDataDir), colorScheme: null })
  mainWindow = await app.firstWindow()
}

async function settingsOnDisk(): Promise<unknown> {
  return readFile(join(userDataDir, 'settings.json'), 'utf8').then(JSON.parse, () => null)
}

const isDark = (): Promise<boolean> =>
  mainWindow.evaluate(() => document.documentElement.classList.contains('dark'))
const themeSource = (): Promise<string> => app.evaluate(({ nativeTheme }) => nativeTheme.themeSource)

async function chooseTheme(name: 'System' | 'Light' | 'Dark'): Promise<void> {
  await mainWindow.getByRole('radiogroup', { name: 'Theme' }).getByRole('radio', { name }).click()
}

test.beforeAll(async () => {
  userDataDir = await createUserDataDir()
  await launch()
  await mainWindow.getByRole('button', { name: 'Settings' }).click()
})

test.afterAll(async () => {
  await app.close()
  await removeUserDataDir(userDataDir)
})

test('choosing Dark turns the whole window dark at once', async () => {
  await chooseTheme('Dark')

  await expect.poll(isDark).toBe(true)
  // Electron's own parts (title bar, scrollbars) follow the same switch.
  await expect.poll(themeSource).toBe('dark')
})

test('choosing Light turns it light again', async () => {
  await chooseTheme('Light')

  await expect.poll(isDark).toBe(false)
  await expect.poll(themeSource).toBe('light')
})

test('System follows the Windows mode', async () => {
  await chooseTheme('System')

  await expect.poll(themeSource).toBe('system')
  const windowsIsDark = await app.evaluate(({ nativeTheme }) => nativeTheme.shouldUseDarkColors)
  await expect.poll(isDark).toBe(windowsIsDark)
})

test('the last tab, the theme and the sidebar survive a restart', async () => {
  // Still on Settings from the tests above: pick Dark there, then leave the app on Automations.
  await chooseTheme('Dark')
  await mainWindow.keyboard.press('Control+3')
  await mainWindow.getByRole('button', { name: 'Close sidebar' }).click()
  await expect
    .poll(settingsOnDisk)
    .toMatchObject({ lastTab: 'automations', theme: 'dark', sidebarOpen: false })

  await app.close()
  await launch()

  // Dark before the page paints: no white flash on the way in.
  const background = await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].getBackgroundColor()
  )
  expect(background.toUpperCase()).toBe('#111113')
  await expect(mainWindow.getByRole('heading', { level: 1, name: 'Automations' })).toBeVisible()
  await expect.poll(isDark).toBe(true)
  await expect(mainWindow.locator('#sidebar')).toHaveAttribute('data-state', 'closed')
})
