import { readdir, writeFile } from 'fs/promises'
import { join } from 'path'
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { appArgs, createUserDataDir, removeUserDataDir } from './testProfile'

let app: ElectronApplication
let mainWindow: Page
let userDataDir: string

// A settings file from before Settings became a dialog (schema version 1), left on the Settings tab.
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
  await expect(mainWindow.getByRole('button', { name: 'Sidebar' })).toHaveAttribute('aria-expanded', 'false')

  // The sidebar is closed (kept from the old file), so open Settings by its shortcut.
  await mainWindow.keyboard.press('Control+,')
  const settings = mainWindow.getByRole('dialog', { name: 'Settings' })
  await expect(settings.getByRole('radio', { name: 'Quit', exact: true })).toBeChecked()
})
