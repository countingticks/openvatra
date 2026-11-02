import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'

let app: ElectronApplication
let mainWindow: Page

test.beforeAll(async () => {
  // '.' starts Electron with this project: package.json "main" points to the built out/main/index.js.
  app = await electron.launch({ args: ['.'] })
  mainWindow = await app.firstWindow()
})

test.afterAll(async () => {
  await app.close()
})

test('opens the main window titled OpenVatra', async () => {
  await expect(mainWindow).toHaveTitle('OpenVatra')
  await expect(mainWindow.getByRole('heading', { level: 1, name: 'OpenVatra' })).toBeVisible()
})

test('shows exactly one window', async () => {
  expect(app.windows()).toHaveLength(1)
})
