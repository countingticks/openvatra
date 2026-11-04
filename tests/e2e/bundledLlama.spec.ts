import { readFile } from 'fs/promises'
import { join } from 'path'
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

test('with no llama-server chosen, Settings → Models offers the bundled build the app was packaged with', async () => {
  const { tag } = JSON.parse(await readFile(join('resources', 'llama', 'llama.json'), 'utf8')) as {
    tag: string
  }

  await mainWindow.getByRole('button', { name: 'Settings' }).click()
  const settings = mainWindow.getByRole('dialog', { name: 'Settings' })
  await settings.getByText('Models', { exact: true }).click()
  // The engine is an advanced option.
  await settings.getByRole('switch', { name: 'Show advanced' }).click()

  await expect(settings.getByText(`Bundled (${tag}, Vulkan)`)).toBeVisible()
  await expect(settings.getByRole('button', { name: 'Browse for llama-server.exe' })).toHaveText(
    'Use my own…'
  )
  await expect(settings.getByRole('button', { name: 'Use bundled' })).toHaveCount(0)
})
