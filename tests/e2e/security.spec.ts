import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'

let app: ElectronApplication
let mainWindow: Page

test.beforeAll(async () => {
  app = await electron.launch({ args: ['.'] })
  mainWindow = await app.firstWindow()
})

test.afterAll(async () => {
  await app.close()
})

test('the window runs sandboxed and isolated, without Node integration', async () => {
  const prefs = await app.evaluate(({ BrowserWindow }) => {
    // getLastWebPreferences() is internal to Electron (not in its typings) but reports the settings the page
    // actually runs with, which is exactly what this test needs to prove. Test-only; never use it in the app.
    type Prefs = { sandbox?: boolean; contextIsolation?: boolean; nodeIntegration?: boolean }
    const contents = BrowserWindow.getAllWindows()[0].webContents as unknown as {
      getLastWebPreferences(): Prefs | null
    }
    const p = contents.getLastWebPreferences()
    return { sandbox: p?.sandbox, contextIsolation: p?.contextIsolation, nodeIntegration: p?.nodeIntegration }
  })

  expect(prefs).toEqual({ sandbox: true, contextIsolation: true, nodeIntegration: false })
})

test('the page cannot reach Node.js or raw Electron APIs', async () => {
  const reachable = await mainWindow.evaluate(() => {
    const w = window as unknown as Record<string, unknown>
    return {
      require: typeof w.require,
      process: typeof w.process,
      module: typeof w.module,
      electron: typeof w.electron
    }
  })

  expect(reachable).toEqual({
    require: 'undefined',
    process: 'undefined',
    module: 'undefined',
    electron: 'undefined'
  })
})

test('the page gets the typed, read-only window.api', async () => {
  const runtime = await mainWindow.evaluate(() => window.api.runtime)
  const actual = await app.evaluate(() => ({
    electron: process.versions.electron,
    node: process.versions.node
  }))

  expect(runtime.platform).toBe(process.platform)
  expect(runtime.versions.electron).toBe(actual.electron)
  expect(runtime.versions.node).toBe(actual.node)

  const frozen = await mainWindow.evaluate(() => Object.isFrozen(window.api.runtime))
  expect(frozen).toBe(true)
})
