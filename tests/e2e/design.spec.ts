import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { appArgs, createUserDataDir, removeUserDataDir } from './testProfile'

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

// The CSP only allows fonts from the app's own files. If a font were blocked, the page would silently fall back
// to a system font, so check that each bundled font really loads inside the packaged app.
for (const family of ['Geist Variable', 'Geist Mono Variable', 'Source Serif 4 Variable']) {
  test(`loads the bundled ${family} font`, async () => {
    const loaded = await mainWindow.evaluate(async (name) => {
      await document.fonts.load(`16px "${name}"`)
      return document.fonts.check(`16px "${name}"`)
    }, family)

    expect(loaded).toBe(true)
  })
}

test('uses Geist as the interface font', async () => {
  const fontFamily = await mainWindow.evaluate(() => getComputedStyle(document.body).fontFamily)

  expect(fontFamily).toMatch(/^"?Geist Variable"?/)
})
