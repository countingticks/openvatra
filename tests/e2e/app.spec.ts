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

test('opens the main window titled OpenVatra', async () => {
  await expect(mainWindow).toHaveTitle('OpenVatra')
  await expect(mainWindow.getByRole('heading', { level: 1, name: 'OpenVatra' })).toBeVisible()
})

test('shows exactly one window', async () => {
  expect(app.windows()).toHaveLength(1)
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
