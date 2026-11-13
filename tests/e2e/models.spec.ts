import { execFile } from 'child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { promisify } from 'util'
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { ggufHeader } from './ggufHeader'
import { appArgs, createUserDataDir, removeUserDataDir } from './testProfile'

const run = promisify(execFile)

let app: ElectronApplication
let mainWindow: Page
let userDataDir: string
let workDir: string

/** The real core.exe is started by the app; only llama-server is replaced, by the fake server from core/testdata. */
test.beforeAll(async () => {
  workDir = await mkdtemp(join(tmpdir(), 'openvatra-e2e-models-'))
  const fakeServer = join(workDir, 'fake-server.exe')
  await run('go', ['build', '-C', 'core', '-o', fakeServer, './testdata/fake-server'])
  const modelsDir = join(workDir, 'models')
  await mkdir(modelsDir)
  await writeFile(join(modelsDir, 'tiny.gguf'), ggufHeader('llama'))

  userDataDir = await createUserDataDir()
  // A v6 file, imported into core on its first ready.
  const settings = {
    schemaVersion: 6,
    models: { llamaServerPath: fakeServer, modelsDir }
  }
  await writeFile(join(userDataDir, 'settings.json'), JSON.stringify(settings))

  app = await electron.launch({ args: appArgs(userDataDir) })
  mainWindow = await app.firstWindow()
})

test.afterAll(async () => {
  await app.close().catch(() => undefined) // the test below may already have closed it
  await removeUserDataDir(userDataDir)
  await rm(workDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
})

/** The pid of the running core.exe, from its core.json: core runs detached, not as a child of the app. */
async function coreExePid(): Promise<number> {
  const text = await readFile(join(userDataDir, 'data', 'core.json'), 'utf8')
  return (JSON.parse(text) as { pid: number }).pid
}

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0) // signal 0 only checks that the process exists
    return true
  } catch {
    return false
  }
}

type CoreStateInPage = { status: string; connection?: { baseUrl: string } }
type PageWithApi = { api: { core: { getState(): Promise<CoreStateInPage>; restart(): Promise<void> } } }

test('after a core restart the models list fills again without reloading the page', async () => {
  const modelButton = mainWindow.getByRole('button', { name: /^Model:/ })
  await modelButton.click()
  await expect(mainWindow.getByRole('button', { name: 'Load tiny' })).toBeVisible()

  await mainWindow.evaluate(() => {
    ;(window as unknown as { __marker: number }).__marker = 1
  })
  const baseUrl = await mainWindow.evaluate(
    async () => (await (window as unknown as PageWithApi).api.core.getState()).connection?.baseUrl
  )
  await mainWindow.evaluate(() => (window as unknown as PageWithApi).api.core.restart())

  // A new core run has a new port and token; the window follows without a reload.
  await expect
    .poll(() =>
      mainWindow.evaluate(async () => {
        const state = await (window as unknown as PageWithApi).api.core.getState()
        return state.status === 'ready' ? state.connection?.baseUrl : undefined
      })
    )
    .not.toBe(baseUrl)
  await expect(mainWindow.getByRole('button', { name: 'Load tiny' })).toBeVisible()
  expect(await mainWindow.evaluate(() => (window as unknown as { __marker: number }).__marker)).toBe(1)
  await mainWindow.keyboard.press('Escape')
})

test('loads a model from the popover, and quitting leaves no core.exe behind', async () => {
  const modelButton = mainWindow.getByRole('button', { name: /^Model:/ })
  await expect(modelButton).toHaveAccessibleName('Model: no model, Ready')

  await modelButton.click()
  await mainWindow.getByRole('button', { name: 'Load tiny' }).click()

  await expect(modelButton).toHaveAccessibleName('Model: tiny, Ready')
  await expect(modelButton).toHaveText('tiny')
  // The loaded row is the unload button and carries the highlight state; no "Ready — …" sentence any more.
  const row = mainWindow.getByRole('button', { name: 'Unload tiny' })
  await expect(row).toHaveAttribute('aria-current', 'true')
  await expect(mainWindow.getByText(/Ready —/)).toHaveCount(0)

  const corePid = await coreExePid()
  expect(corePid).toBeGreaterThan(0)
  await app.close()
  await expect.poll(() => isRunning(corePid)).toBe(false)
})
