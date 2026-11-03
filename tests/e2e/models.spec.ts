import { execFile } from 'child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { promisify } from 'util'
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { settingsSchemaVersion } from '../../src/shared/settings'
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
  await writeFile(join(modelsDir, 'tiny.gguf'), 'not a real model')

  userDataDir = await createUserDataDir()
  const settings = {
    schemaVersion: settingsSchemaVersion,
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

/** The pid of core.exe among the app's children; Windows only, like the app. */
async function coreExePid(parentPid: number): Promise<number> {
  const { stdout } = await run('powershell', [
    '-NoProfile',
    '-Command',
    `(Get-CimInstance Win32_Process -Filter "ParentProcessId=${parentPid} AND Name='core.exe'").ProcessId`
  ])
  return Number(stdout.trim())
}

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0) // signal 0 only checks that the process exists
    return true
  } catch {
    return false
  }
}

test('loads a model from the popover, and quitting leaves no core.exe behind', async () => {
  const modelButton = mainWindow.getByRole('button', { name: /^Model:/ })
  await expect(modelButton).toHaveAccessibleName('Model: no model, Ready')

  await modelButton.click()
  await mainWindow.getByRole('button', { name: 'Load tiny' }).click()

  await expect(modelButton).toHaveAccessibleName('Model: tiny, Ready')
  await expect(modelButton).toHaveText('tiny')
  await expect(mainWindow.getByRole('button', { name: 'Unload tiny' })).toBeVisible()

  const corePid = await coreExePid(await app.evaluate(() => process.pid))
  expect(corePid).toBeGreaterThan(0)
  await app.close()
  await expect.poll(() => isRunning(corePid)).toBe(false)
})
