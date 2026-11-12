import { mkdtemp, readdir, readFile, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import type { Api } from '../../src/shared/ipc'
import { appArgs, createUserDataDir, removeUserDataDir } from './testProfile'

// These callbacks run inside the app's page, where the preload put the API on `window`.
type WithApi = typeof globalThis & { api: Api }

// A settings file from before Settings became a dialog (schema version 1), left on the Settings tab.
test.describe('a version-1 settings file', () => {
  let app: ElectronApplication
  let mainWindow: Page
  let userDataDir: string

  test.beforeAll(async () => {
    userDataDir = await createUserDataDir()
    await writeFile(
      join(userDataDir, 'settings.json'),
      JSON.stringify({ schemaVersion: 1, lastTab: 'settings', closeAction: 'quit', sidebarOpen: false })
    )
    app = await electron.launch({ args: appArgs(userDataDir) })
    mainWindow = await app.firstWindow()
  })

  test.afterAll(async () => {
    await app.close()
    await removeUserDataDir(userDataDir)
  })

  test('an old file left on the Settings tab opens on Chat', async () => {
    await expect(mainWindow.getByRole('heading', { level: 1, name: 'Chat' })).toBeVisible()
  })

  test('keeps the rest of the old file instead of setting it aside', async () => {
    // Nothing was moved to settings.json.bak: the file was upgraded, not rejected.
    expect(await readdir(userDataDir)).not.toContain('settings.json.bak')
    await expect(mainWindow.getByRole('button', { name: 'Sidebar' })).toHaveAttribute(
      'aria-expanded',
      'false'
    )

    // The sidebar is closed (kept from the old file), so open Settings by its shortcut.
    await mainWindow.keyboard.press('Control+,')
    const settings = mainWindow.getByRole('dialog', { name: 'Settings' })
    await expect(settings.getByRole('radio', { name: 'Quit', exact: true })).toBeChecked()
  })
})

// A version-6 file still holds the model settings; core owns them from version 7, so main imports them once.
test.describe('a version-6 settings file with model settings', () => {
  let app: ElectronApplication
  let mainWindow: Page
  let userDataDir: string
  let modelsDir: string

  test.beforeAll(async () => {
    modelsDir = await mkdtemp(join(tmpdir(), 'openvatra-e2e-models-'))
    userDataDir = await createUserDataDir()
    await writeFile(
      join(userDataDir, 'settings.json'),
      JSON.stringify({
        schemaVersion: 6,
        models: {
          modelsDir,
          idleUnloadMinutes: 30,
          options: { qwen: { args: '-c 8192' } },
          showAdvanced: true
        }
      })
    )
    app = await electron.launch({ args: appArgs(userDataDir) })
    mainWindow = await app.firstWindow()
  })

  test.afterAll(async () => {
    await app.close()
    await removeUserDataDir(userDataDir)
    await rm(modelsDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  })

  test('moves the model settings into core and keeps showing them', async () => {
    const onDisk = async (): Promise<Record<string, unknown>> =>
      JSON.parse(await readFile(join(userDataDir, 'settings.json'), 'utf8')) as Record<string, unknown>
    const models = (): Promise<unknown> =>
      mainWindow.evaluate(async () => (await (window as WithApi).api.settings.get()).models)
    const imported = {
      modelsDir,
      idleUnloadMinutes: 30,
      options: { qwen: { args: '-c 8192' } },
      showAdvanced: true
    }

    await expect.poll(models).toMatchObject(imported)
    // The old copy is dropped only once core has the values, so from then on they can only come from core.
    await expect.poll(onDisk).not.toHaveProperty('legacyModels')
    expect(await models()).toMatchObject(imported)

    const file = await onDisk()
    expect(file).toMatchObject({ schemaVersion: 7, showAdvancedModels: true })
    expect(file).not.toHaveProperty('models')

    await mainWindow.getByRole('button', { name: 'Settings' }).click()
    const settings = mainWindow.getByRole('dialog', { name: 'Settings' })
    await settings.getByRole('button', { name: 'Models' }).click()
    await expect(settings.getByText(modelsDir)).toBeVisible()
  })
})
