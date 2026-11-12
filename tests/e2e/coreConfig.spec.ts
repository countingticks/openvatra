import { readFile } from 'fs/promises'
import { join } from 'path'
import { _electron as electron, expect, test } from '@playwright/test'
import type { Api } from '../../src/shared/ipc'
import { appArgs, createUserDataDir, removeUserDataDir } from './testProfile'

// These callbacks run inside the app's page, where the preload put the API on `window`.
type WithApi = typeof globalThis & { api: Api }

test('the unload timer survives a restart and is not in settings.json', async () => {
  const userDataDir = await createUserDataDir()
  try {
    const first = await electron.launch({ args: appArgs(userDataDir) })
    const firstWindow = await first.firstWindow()
    // The update rejects until core is ready, so poll until it goes through.
    await expect
      .poll(() =>
        firstWindow.evaluate(async () => {
          try {
            await (window as WithApi).api.settings.update({ models: { idleUnloadMinutes: 60 } })
            return true
          } catch {
            return false
          }
        })
      )
      .toBe(true)
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
      await expect
        .poll(() =>
          secondWindow.evaluate(async () => {
            try {
              return (await (window as WithApi).api.settings.get()).models.idleUnloadMinutes
            } catch {
              return null
            }
          })
        )
        .toBe(60)
    } finally {
      await second.close()
    }
  } finally {
    await removeUserDataDir(userDataDir)
  }
})
