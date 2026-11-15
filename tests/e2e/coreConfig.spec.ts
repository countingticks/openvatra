import { mkdtemp, mkdir, readFile, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { _electron as electron, expect, test, type Page } from '@playwright/test'
import type { Api } from '../../src/shared/ipc'
import { ggufHeader } from './ggufHeader'
import { appArgs, createUserDataDir, removeUserDataDir } from './testProfile'

// This callback runs inside the app's page, where the preload put the API on `window`.
type WithApi = typeof globalThis & { api: Api }

async function openModels(page: Page): Promise<ReturnType<Page['getByRole']>> {
  await page.getByRole('button', { name: 'Settings' }).click()
  const dialog = page.getByRole('dialog', { name: 'Settings' })
  await dialog.getByRole('button', { name: 'Models' }).click()
  return dialog
}

test("the unload timer and a model's arguments survive a restart and are not in settings.json", async () => {
  const workDir = await mkdtemp(join(tmpdir(), 'openvatra-e2e-core-config-'))
  const modelsDir = join(workDir, 'models')
  await mkdir(modelsDir)
  await writeFile(join(modelsDir, 'tiny.gguf'), ggufHeader('llama'))
  const userDataDir = await createUserDataDir()
  // A v6 file, imported into core on its first ready; nothing loads, so no fake server is needed.
  await writeFile(
    join(userDataDir, 'settings.json'),
    JSON.stringify({ schemaVersion: 6, models: { modelsDir } })
  )
  try {
    const first = await electron.launch({ args: appArgs(userDataDir) })
    const firstWindow = await first.firstWindow()
    const dialog = await openModels(firstWindow)
    // Core may still be starting, so the radio is enabled only once it answers.
    const hour = dialog.getByRole('radio', { name: '1 hour' })
    await expect(hour).toBeEnabled()
    await hour.click()
    await expect(hour).toBeChecked()

    const advanced = dialog.getByRole('switch', { name: 'Show advanced' })
    if ((await advanced.getAttribute('aria-checked')) !== 'true') await advanced.click()
    await dialog.getByRole('button', { name: 'Options for tiny' }).click()
    const args = dialog.getByRole('textbox', { name: 'Arguments' })
    await args.fill('--temp 0.5')
    // The field saves on blur.
    await args.blur()
    await expect
      .poll(() =>
        firstWindow.evaluate(async () => {
          const state = await (window as WithApi).api.core.getState()
          if (state.status !== 'ready') return null
          const { baseUrl, token } = state.connection
          const response = await fetch(baseUrl + '/api/config/provider.llamacpp', {
            headers: { Authorization: 'Bearer ' + token }
          })
          if (!response.ok) return null
          const body = (await response.json()) as {
            value: { options: Record<string, { args?: string }> }
          }
          return body.value.options['tiny']?.args ?? null
        })
      )
      .toBe('--temp 0.5')
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
      const secondDialog = await openModels(secondWindow)
      await expect(secondDialog.getByRole('radio', { name: '1 hour' })).toBeChecked()
      await secondDialog.getByRole('button', { name: 'Options for tiny' }).click()
      await expect(secondDialog.getByRole('textbox', { name: 'Arguments' })).toHaveValue('--temp 0.5')
    } finally {
      await second.close()
    }
  } finally {
    await removeUserDataDir(userDataDir)
    await rm(workDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
})
