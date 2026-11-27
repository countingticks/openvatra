import { readdir, readFile, writeFile } from 'fs/promises'
import { join } from 'path'
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { appArgs, createUserDataDir, removeUserDataDir } from './testProfile'

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
      .toMatchObject({ schemaVersion: 9, lastRoute: 'automations' })
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
    // The tab, not a heading: the chat's "New chat" heading gives way to the welcome card once core lists no chat
    // model, and the sidebar is closed (inert) here, hence includeHidden.
    await expect(
      mainWindow
        .getByRole('navigation', { name: 'Main', includeHidden: true })
        .getByRole('button', { name: 'Chat', includeHidden: true })
    ).toHaveAttribute('aria-current', 'page')
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
