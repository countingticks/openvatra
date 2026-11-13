import { createServer } from 'http'
import type { AddressInfo } from 'net'
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { appArgs, createUserDataDir, removeUserDataDir } from './testProfile'

let app: ElectronApplication
let mainWindow: Page
let userDataDir: string

type Recorder = typeof globalThis & { openedExternally: string[] }

test.beforeAll(async () => {
  userDataDir = await createUserDataDir()
  app = await electron.launch({ args: appArgs(userDataDir) })
  mainWindow = await app.firstWindow()

  // Test double: record what would open in the user's browser instead of really opening it.
  await app.evaluate(({ shell }) => {
    const recorder = globalThis as Recorder
    recorder.openedExternally = []
    shell.openExternal = async (url: string): Promise<void> => {
      recorder.openedExternally.push(url)
    }
  })
})

async function openedExternally(): Promise<string[]> {
  return app.evaluate(() => (globalThis as Recorder).openedExternally)
}

/** Adds a link to the page and clicks it, like a user clicking a link inside a chat message. */
async function clickLink(href: string): Promise<void> {
  await mainWindow.evaluate((url) => {
    const link = document.createElement('a')
    link.href = url
    link.textContent = 'test link'
    document.body.append(link)
    link.click()
    link.remove()
  }, href)
}

test.afterAll(async () => {
  await app.close()
  await removeUserDataDir(userDataDir)
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

test('window.api offers exactly the reviewed functions, nothing more', async () => {
  // An allow-list: anything added to the API must be added here too, on purpose.
  const shape = await mainWindow.evaluate(() => ({
    api: Object.keys(window.api).sort(),
    settings: Object.keys(window.api.settings).sort(),
    settingsFrozen: Object.isFrozen(window.api.settings),
    files: Object.keys(window.api.files).sort(),
    filesFrozen: Object.isFrozen(window.api.files),
    appWindow: Object.keys(window.api.appWindow).sort(),
    appWindowFrozen: Object.isFrozen(window.api.appWindow),
    app: Object.keys(window.api.app).sort(),
    appFrozen: Object.isFrozen(window.api.app),
    core: Object.keys(window.api.core).sort(),
    coreFrozen: Object.isFrozen(window.api.core)
  }))

  expect(shape).toEqual({
    api: ['app', 'appWindow', 'core', 'files', 'runtime', 'settings'],
    // Added in 024 (core-config): main pushes saved settings.
    settings: ['get', 'onChange', 'update'],
    settingsFrozen: true,
    // Added in T25 (approved 2026-11-02): read-only locations, and opening one of two named folders. T56 (2026-11-03): the bundled llama.cpp's tag, and going back to it.
    files: ['bundledLlama', 'locations', 'openFolder', 'pick', 'useBundledLlama'],
    filesFrozen: true,
    // Added in T27 (approved 2026-11-02): the window buttons, acting only on the sender's own window.
    // T28 adds edit: one of six named Edit commands, checked against an allow-list in main.
    appWindow: ['close', 'edit', 'isMaximized', 'minimize', 'onMaximizedChange', 'toggleMaximize'],
    appWindowFrozen: true,
    // Added in T28 (approved 2026-11-02): File → Quit and Ctrl+Q.
    app: ['quit'],
    appFrozen: true,
    // Added in T37: watch the models service, restart it, open its log. Never its token.
    core: ['getState', 'onState', 'openLog', 'restart'],
    coreFrozen: true
  })
})

test('a web link opens in the browser and the app stays on its own page', async () => {
  const appUrl = mainWindow.url()

  await clickLink('https://example.com/from-link')

  await expect.poll(openedExternally).toContain('https://example.com/from-link')
  expect(mainWindow.url()).toBe(appUrl)
})

test('window.open never creates an app window', async () => {
  const result = await mainWindow.evaluate(() => window.open('https://example.org/popup') === null)

  expect(result).toBe(true)
  await expect.poll(openedExternally).toContain('https://example.org/popup')
  expect(app.windows()).toHaveLength(1)
})

test("the page reaches core's port and no other loopback port", async () => {
  // Stands in for llama-server or any other local service the page must not reach.
  let received = 0
  const other = createServer((_request, response) => {
    received++
    response.end('reached')
  })
  await new Promise<void>((resolve) => other.listen(0, '127.0.0.1', resolve))
  try {
    const { port } = other.address() as AddressInfo
    const blocked = await mainWindow.evaluate(async (url) => {
      try {
        await fetch(url)
        return false
      } catch {
        return true
      }
    }, `http://127.0.0.1:${port}/`)
    expect(blocked).toBe(true)
    expect(received).toBe(0)
  } finally {
    await new Promise((resolve) => other.close(resolve))
  }

  await expect
    .poll(() => mainWindow.evaluate(async () => (await window.api.core.getState()).status), {
      timeout: 30_000
    })
    .toBe('ready')
  const answer = await mainWindow.evaluate(async () => {
    const state = await window.api.core.getState()
    if (state.status !== 'ready') throw new Error('core is not ready')
    const { baseUrl, token } = state.connection
    const response = await fetch(`${baseUrl}/api/version`, { headers: { Authorization: `Bearer ${token}` } })
    return { status: response.status, body: (await response.json()) as { api?: unknown } }
  })
  expect(answer.status).toBe(200)
  expect(answer.body.api).toBe(1)
})

test('links to local files or other protocols go nowhere', async () => {
  const appUrl = mainWindow.url()

  await clickLink('file:///C:/Windows/win.ini')
  await clickLink('ms-settings:privacy')

  // Give a blocked navigation time to (not) happen, then check nothing moved or opened.
  await mainWindow.waitForTimeout(500)
  expect(mainWindow.url()).toBe(appUrl)
  expect(await openedExternally()).not.toContain('file:///C:/Windows/win.ini')
  expect(await openedExternally()).not.toContain('ms-settings:privacy')
})
