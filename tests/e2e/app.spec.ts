import { spawn } from 'child_process'
import { createRequire } from 'module'
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { appArgs, createUserDataDir, removeUserDataDir } from './testProfile'

// In Node, the 'electron' package exports the path of the Electron executable.
const electronPath = createRequire(__filename)('electron') as string

let app: ElectronApplication
let mainWindow: Page
let userDataDir: string

test.beforeAll(async () => {
  userDataDir = await createUserDataDir()
  app = await electron.launch({ args: appArgs(userDataDir) })
  mainWindow = await app.firstWindow()
})

test.afterAll(async () => {
  await app.close()
  await removeUserDataDir(userDataDir)
})

test('opens the main window titled OpenVatra, on the Chat tab', async () => {
  await expect(mainWindow).toHaveTitle('OpenVatra')
  await expect(mainWindow.getByRole('navigation', { name: 'Main' })).toBeVisible()
  await expect(
    mainWindow.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'Chat' })
  ).toHaveAttribute('aria-current', 'page')
})

test('switches tabs with Ctrl+number in the real window', async () => {
  // Runs in Electron, where a menu or the OS could swallow the keys before the page sees them.
  await mainWindow.keyboard.press('Control+2')
  await expect(
    mainWindow.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'Code' })
  ).toHaveAttribute('aria-current', 'page')

  await mainWindow.keyboard.press('Control+1')
  await expect(
    mainWindow.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'Chat' })
  ).toHaveAttribute('aria-current', 'page')
})

test('shows exactly one window', async () => {
  expect(app.windows()).toHaveLength(1)
})

test('Ctrl+B slides the sidebar closed and open again', async () => {
  // Real CSS only exists here (jsdom has none): check the panel's actual width, not just its data-state.
  const panelWidth = (): Promise<number> =>
    mainWindow.evaluate(() => document.getElementById('sidebar')?.getBoundingClientRect().width ?? -1)

  await mainWindow.keyboard.press('Control+b')
  await expect.poll(panelWidth).toBe(0)
  await expect(mainWindow.getByRole('button', { name: 'Sidebar' })).toHaveAttribute('aria-expanded', 'false')
  await expect(mainWindow.getByRole('navigation', { name: 'Main' })).toBeHidden()

  await mainWindow.keyboard.press('Control+b')
  await expect.poll(panelWidth).toBe(224)
  await expect(mainWindow.getByRole('navigation', { name: 'Main' })).toBeVisible()
})

test('a second launch exits and hands over to the running app', async () => {
  await app.evaluate(({ app: electronApp }) => {
    const counter = globalThis as typeof globalThis & { secondLaunches: number }
    counter.secondLaunches = 0
    electronApp.on('second-instance', () => counter.secondLaunches++)
  })

  // Same profile as the running app: the single-instance lock belongs to the user-data folder.
  const second = spawn(electronPath, appArgs(userDataDir), { stdio: 'ignore' })
  const exitCode = await new Promise<number | null>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('second instance did not exit within 15 s')), 15_000)
    second.on('exit', (code) => {
      clearTimeout(timer)
      resolve(code)
    })
  })

  expect(exitCode).toBe(0)
  await expect
    .poll(() =>
      app.evaluate(() => (globalThis as typeof globalThis & { secondLaunches: number }).secondLaunches)
    )
    .toBe(1)
  expect(app.windows()).toHaveLength(1)
})
