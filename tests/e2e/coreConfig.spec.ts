import { readFile } from 'fs/promises'
import { join } from 'path'
import { _electron as electron, expect, test } from '@playwright/test'
import { appArgs, createUserDataDir, removeUserDataDir } from './testProfile'

test('the unload timer survives a restart and is not in settings.json', async () => {
  const userDataDir = await createUserDataDir()
  try {
    const first = await electron.launch({ args: appArgs(userDataDir) })
    const firstWindow = await first.firstWindow()
    // Core may still be starting, so the dialog's radio is enabled only once it answers.
    await firstWindow.getByRole('button', { name: 'Settings' }).click()
    const dialog = firstWindow.getByRole('dialog', { name: 'Settings' })
    await dialog.getByRole('button', { name: 'Models' }).click()
    const hour = dialog.getByRole('radio', { name: '1 hour' })
    await expect(hour).toBeEnabled()
    await hour.click()
    await expect(hour).toBeChecked()
    await first.close()

    const file = JSON.parse(await readFile(join(userDataDir, 'settings.json'), 'utf8')) as Record<
      string,
      unknown
    >
    expect(file).not.toHaveProperty('models')
    expect(file).not.toHaveProperty('legacyModels')

    const second = await electron.launch({ args: appArgs(userDataDir) })
    try {
      const secondWindow = await second.firstWindow()
      await secondWindow.getByRole('button', { name: 'Settings' }).click()
      const dialog = secondWindow.getByRole('dialog', { name: 'Settings' })
      await dialog.getByRole('button', { name: 'Models' }).click()
      await expect(dialog.getByRole('radio', { name: '1 hour' })).toBeChecked()
    } finally {
      await second.close()
    }
  } finally {
    await removeUserDataDir(userDataDir)
  }
})
