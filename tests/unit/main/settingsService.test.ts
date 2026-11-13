// @vitest-environment node
import { describe, expect, it, type Mock, vi } from 'vitest'
import { ZodError } from 'zod'
import type { saveSettings } from '../../../src/main/settings'
import { createSettingsService, type SettingsService } from '../../../src/main/settingsService'
import { createSettingsStore, type SettingsStore } from '../../../src/main/settingsStore'
import {
  defaultSettings,
  defaultSettingsFile,
  legacyModelsSchema,
  type SettingsFile
} from '../../../src/shared/settings'

type Save = typeof saveSettings

interface Fixture {
  service: SettingsService
  store: SettingsStore
  save: Mock<Save>
}

function setUp(file: SettingsFile = defaultSettingsFile): Fixture {
  const save = vi.fn<Save>(async () => undefined)
  const store = createSettingsStore('D:/data/settings.json', file, save)
  return { service: createSettingsService(store), store, save }
}

describe('settings service', () => {
  it('get drops legacyModels', () => {
    const { service } = setUp({
      ...defaultSettingsFile,
      cudaOfferDismissed: true,
      legacyModels: legacyModelsSchema.parse({ modelsDir: 'D:/Models' })
    })

    expect(service.get()).toEqual({ ...defaultSettings, cudaOfferDismissed: true })
    expect(service.get()).not.toHaveProperty('legacyModels')
  })

  it('update saves the file and answers the new settings', async () => {
    const { service, store, save } = setUp()

    const settings = await service.update({ theme: 'dark', showAdvancedModels: true })

    expect(settings).toEqual({ ...defaultSettings, theme: 'dark', showAdvancedModels: true })
    expect(store.get()).toMatchObject({ theme: 'dark', showAdvancedModels: true })
    expect(save).toHaveBeenCalledWith('D:/data/settings.json', {
      ...defaultSettingsFile,
      theme: 'dark',
      showAdvancedModels: true
    })
  })

  it('an empty patch saves nothing', async () => {
    const { service, save } = setUp()

    await service.update({})

    expect(save).not.toHaveBeenCalled()
  })

  it.each([
    ['an unknown key', { colour: 'red' }],
    ['models', { models: { engine: 'cuda' } }],
    ['window bounds', { window: { x: 0, y: 0, width: 900, height: 600 } }]
  ])('an invalid patch rejects before anything is saved (%s)', async (_case, patch) => {
    const { service, save } = setUp()

    await expect(service.update(patch)).rejects.toBeInstanceOf(ZodError)

    expect(save).not.toHaveBeenCalled()
  })

  it('onChange fires once per real change', async () => {
    const { service } = setUp()
    const listener = vi.fn()
    service.onChange(listener)

    await service.update({ theme: 'dark' })
    expect(listener).toHaveBeenCalledTimes(1)
    expect(listener).toHaveBeenLastCalledWith({ ...defaultSettings, theme: 'dark' })

    await service.update({ theme: 'dark' }) // saved again, but nothing changed
    expect(listener).toHaveBeenCalledTimes(1)

    await service.update({ cudaOfferDismissed: true })
    expect(listener).toHaveBeenCalledTimes(2)
  })
})
