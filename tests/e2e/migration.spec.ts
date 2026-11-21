import { mkdtemp, readdir, readFile, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import type { Api } from '../../src/shared/ipc'
import { appArgs, createUserDataDir, removeUserDataDir } from './testProfile'

// These callbacks run inside the app's page, where the preload put the API on `window`.
type WithApi = typeof globalThis & { api: Api }

// A settings file from before `lastTab` became `lastRoute` (schema version 7), left on the Code tab.
test.describe('a version-7 settings file', () => {
  let app: ElectronApplication
  let mainWindow: Page
  let userDataDir: string

  test.beforeAll(async () => {
    userDataDir = await createUserDataDir()
    await writeFile(join(userDataDir, 'settings.json'), JSON.stringify({ schemaVersion: 7, lastTab: 'code' }))
    app = await electron.launch({ args: appArgs(userDataDir) })
    mainWindow = await app.firstWindow()
  })

  test.afterAll(async () => {
    await app.close()
    await removeUserDataDir(userDataDir)
  })

  test('opens on its last tab and saves lastRoute from then on', async () => {
    const heading = mainWindow.getByRole('heading', { level: 1, name: 'Code' })
    await expect(heading).toBeVisible()

    // A freshly launched window has no keyboard focus yet; click into the page so the shortcut reaches it.
    await heading.click()
    await mainWindow.keyboard.press('Control+3')

    await expect
      .poll(async () => JSON.parse(await readFile(join(userDataDir, 'settings.json'), 'utf8')) as unknown)
      .toMatchObject({ schemaVersion: 8, lastRoute: 'automations' })
    expect(await readFile(join(userDataDir, 'settings.json'), 'utf8')).not.toContain('lastTab')
  })
})

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
    // core's own section, read with the connection the window has; null while core is not ready.
    const models = (): Promise<unknown> =>
      mainWindow.evaluate(async () => {
        const state = await (window as WithApi).api.core.getState()
        if (state.status !== 'ready') return null
        const { baseUrl, token } = state.connection
        const response = await fetch(baseUrl + '/api/config/provider.llamacpp', {
          headers: { Authorization: 'Bearer ' + token }
        })
        return response.ok ? ((await response.json()) as { value: unknown }).value : null
      })
    const imported = {
      modelsDir,
      idleUnloadMinutes: 30,
      options: { qwen: { context: 8192 } }
    }

    await expect.poll(models).toMatchObject(imported)
    // The old copy is dropped only once core has the values, so from then on they can only come from core. The file
    // on disk stays v6 (no `legacyModels` either) until that save, so wait for the v8 file without it.
    await expect
      .poll(async () => {
        const file = await onDisk()
        return file['schemaVersion'] === 8 && !('legacyModels' in file)
      })
      .toBe(true)
    expect(await models()).toMatchObject(imported)
    expect((await mainWindow.evaluate(() => (window as WithApi).api.settings.get())).showAdvancedModels).toBe(
      true
    )

    const file = await onDisk()
    expect(file).toMatchObject({ schemaVersion: 8, showAdvancedModels: true })
    expect(file).not.toHaveProperty('models')

    await mainWindow.getByRole('button', { name: 'Settings' }).click()
    const settings = mainWindow.getByRole('dialog', { name: 'Settings' })
    await settings.getByRole('button', { name: 'Models' }).click()
    await expect(settings.getByText(modelsDir)).toBeVisible()
  })
})
