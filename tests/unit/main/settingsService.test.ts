// @vitest-environment node
import { describe, expect, it, type Mock, vi } from 'vitest'
import { ZodError } from 'zod'
import { createConfigClient, type CoreModels, type ModelsEntry } from '../../../src/main/core/configClient'
import { createModelSettings } from '../../../src/main/core/modelSettings'
import type { saveSettings } from '../../../src/main/settings'
import {
  createSettingsService,
  ModelsUpdateError,
  type SettingsService,
  updateErrorMessage
} from '../../../src/main/settingsService'
import { createSettingsStore, type SettingsStore } from '../../../src/main/settingsStore'
import {
  defaultSettings,
  defaultSettingsFile,
  legacyModelsSchema,
  type SettingsFile
} from '../../../src/shared/settings'

type Request = (path: string, init?: RequestInit) => Promise<Response>
type Save = typeof saveSettings

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

const coreDefaults: CoreModels = legacyModelsSchema.parse({})
const effective = {
  llamaServerPath: 'C:\\app\\llama-server.exe',
  modelsDir: 'C:\\Users\\me\\OpenVatra\\Models'
}

interface Fixture {
  service: SettingsService
  store: SettingsStore
  save: Mock<Save>
  request: Mock<Request>
  /** The PUT bodies core received. */
  puts: () => { rev: number; value: CoreModels }[]
  /** core's own copy, as a GET would answer it. */
  core: () => ModelsEntry
  /** Answers sent before the fake core's own, one per request. */
  answers: Response[]
  /** core is ready; the store and core read once, like the app on ready. */
  ready: () => Promise<void>
  setReady: (ready: boolean) => void
  /** Someone else (core's engine switch) writes the section. */
  coreWrites: (change: Partial<CoreModels>) => void
}

function setUp(file: SettingsFile = defaultSettingsFile, coreValue: CoreModels = coreDefaults): Fixture {
  let stored: ModelsEntry = { rev: 1, value: coreValue, effective }
  let isReady = true
  const answers: Response[] = []
  const request = vi.fn<Request>(async (_path, init) => {
    const answer = answers.shift()
    if (answer) return answer
    if (init?.method !== 'PUT') return json(stored)
    const body = JSON.parse(init.body as string) as { rev: number; value: CoreModels }
    if (body.rev !== stored.rev) {
      return json({ error: 'config_conflict', message: 'the section changed', current: stored }, 409)
    }
    stored = { rev: stored.rev + 1, value: body.value, effective }
    return json(stored)
  })
  const save = vi.fn<Save>(async () => undefined)
  const store = createSettingsStore('D:/data/settings.json', file, save)
  const models = createModelSettings({
    client: createConfigClient(request),
    isReady: () => isReady,
    log: { warn: vi.fn() }
  })
  const service = createSettingsService(store, models)
  return {
    service,
    store,
    save,
    request,
    puts: () =>
      request.mock.calls
        .filter(([, init]) => init?.method === 'PUT')
        .map(([, init]) => JSON.parse(init?.body as string) as { rev: number; value: CoreModels }),
    core: () => stored,
    answers,
    ready: async () => {
      isReady = true
      await models.refresh()
    },
    setReady: (ready) => (isReady = ready),
    coreWrites: (change) => {
      stored = { rev: stored.rev + 1, value: { ...stored.value, ...change }, effective }
      models.noteChanged('models', stored.rev)
    }
  }
}

const legacyModels: CoreModels = { ...coreDefaults, modelsDir: 'D:\\Models', idleUnloadMinutes: 30 }

describe('settings service', () => {
  it('before core answers, models are legacyModels, else the defaults', () => {
    const withLegacy = setUp({ ...defaultSettingsFile, legacyModels, showAdvancedModels: true })
    const without = setUp()

    expect(withLegacy.service.get()).toEqual({
      ...defaultSettings,
      models: { ...legacyModels, showAdvanced: true, cudaOfferDismissed: false }
    })
    expect(without.service.get()).toEqual(defaultSettings)
    expect(withLegacy.request).not.toHaveBeenCalled()
  })

  it("after core answers, models are core's value with the two file flags", async () => {
    const coreValue: CoreModels = { ...coreDefaults, embeddingModel: 'nomic', engine: 'cuda' }
    const { service, ready } = setUp(
      { ...defaultSettingsFile, legacyModels, cudaOfferDismissed: true },
      coreValue
    )

    await ready()

    expect(service.get()).toEqual({
      ...defaultSettings,
      models: { ...coreValue, showAdvanced: false, cudaOfferDismissed: true }
    })
    expect(service.get()).not.toHaveProperty('legacyModels')
  })

  it('a theme change saves the file and sends nothing to core', async () => {
    const { service, save, request, ready } = setUp()
    await ready()
    request.mockClear()

    const settings = await service.update({ theme: 'dark' })

    expect(settings.theme).toBe('dark')
    expect(save).toHaveBeenCalledWith('D:/data/settings.json', { ...defaultSettingsFile, theme: 'dark' })
    expect(request).not.toHaveBeenCalled()
  })

  it('showAdvanced and cudaOfferDismissed go to the file', async () => {
    const { service, store, puts, ready } = setUp()
    await ready()

    const settings = await service.update({ models: { showAdvanced: true, cudaOfferDismissed: true } })

    expect(store.get()).toMatchObject({ showAdvancedModels: true, cudaOfferDismissed: true })
    expect(settings.models).toMatchObject({ showAdvanced: true, cudaOfferDismissed: true })
    expect(puts()).toEqual([])
  })

  it('an embedding change is PUT to core and nothing is saved to the file', async () => {
    const { service, save, puts, ready } = setUp()
    await ready()

    const settings = await service.update({ models: { embeddingModel: 'nomic' } })

    expect(puts()).toEqual([{ rev: 1, value: { ...coreDefaults, embeddingModel: 'nomic' } }])
    expect(settings.models.embeddingModel).toBe('nomic')
    expect(save).not.toHaveBeenCalled()
  })

  it('a mixed patch whose core part is rejected saves nothing', async () => {
    const { service, save, answers, ready } = setUp()
    await ready()
    answers.push(json({ error: 'invalid_config', message: 'embeddingModel must not be empty' }, 400))

    await expect(service.update({ theme: 'dark', models: { embeddingModel: 'nomic' } })).rejects.toThrow()

    expect(save).not.toHaveBeenCalled()
    expect(service.get().theme).toBe('system')
  })

  it("a core rejection is a ModelsUpdateError with core's message", async () => {
    const { service, answers, ready } = setUp()
    await ready()
    answers.push(json({ error: 'invalid_config', message: 'options for "qwen": unclosed quote' }, 400))

    const update = service.update({ models: { options: { qwen: { args: '-c 1' } } } })

    await expect(update).rejects.toBeInstanceOf(ModelsUpdateError)
    await expect(update).rejects.toThrow('options for "qwen": unclosed quote')
  })

  it("while core is not ready, a core key rejects with 'The models service is not running'", async () => {
    const { service, request, setReady } = setUp()
    setReady(false)

    await expect(service.update({ models: { engine: 'cuda' } })).rejects.toThrow(
      'The models service is not running'
    )
    expect(request).not.toHaveBeenCalled()
  })

  it.each([
    ['an unknown key', { colour: 'red' }],
    ['a path from the window', { models: { llamaServerPath: 'C:/evil.exe' } }],
    ['an unknown engine', { models: { engine: 'rocm' } }],
    ['window bounds', { window: { x: 0, y: 0, width: 900, height: 600 } }]
  ])('an invalid patch rejects before anything is sent (%s)', async (_case, patch) => {
    const { service, save, request, ready } = setUp()
    await ready()
    request.mockClear()

    await expect(service.update(patch)).rejects.toBeInstanceOf(ZodError)

    expect(save).not.toHaveBeenCalled()
    expect(request).not.toHaveBeenCalled()
  })

  it('setModelPath sends the path to core; null sends null', async () => {
    const { service, puts, save, ready } = setUp()
    await ready()

    const chosen = await service.setModelPath('modelsDir', 'D:\\Models')
    await service.setModelPath('llamaServerPath', null)

    expect(chosen.models.modelsDir).toBe('D:\\Models')
    expect(puts()).toEqual([
      { rev: 1, value: { ...coreDefaults, modelsDir: 'D:\\Models' } },
      { rev: 2, value: { ...coreDefaults, modelsDir: 'D:\\Models', llamaServerPath: null } }
    ])
    expect(save).not.toHaveBeenCalled()
  })

  it('onChange fires once per real change, from the file or from core', async () => {
    const { service, ready, coreWrites } = setUp()
    const listener = vi.fn()
    service.onChange(listener)

    await ready() // core's value equals the defaults shown before: no change
    expect(listener).not.toHaveBeenCalled()

    await service.update({ theme: 'dark' })
    expect(listener).toHaveBeenCalledTimes(1)
    expect(listener).toHaveBeenLastCalledWith({ ...defaultSettings, theme: 'dark' })

    await service.update({ theme: 'dark' }) // saved again, but nothing changed
    expect(listener).toHaveBeenCalledTimes(1)

    coreWrites({ engine: 'cuda' })
    await vi.waitFor(() => expect(listener).toHaveBeenCalledTimes(2))
    expect(listener).toHaveBeenLastCalledWith({
      ...defaultSettings,
      theme: 'dark',
      models: { ...defaultSettings.models, engine: 'cuda' }
    })
  })

  it("updateErrorMessage gives core's sentence for a ModelsUpdateError and the generic text for a ZodError or a save failure", async () => {
    const { service } = setUp()
    const zodError: unknown = await service.update({ theme: 'blue' }).catch((error: unknown) => error)

    expect(updateErrorMessage(new ModelsUpdateError('modelsDir must be an absolute path'))).toBe(
      'modelsDir must be an absolute path'
    )
    expect(updateErrorMessage(zodError)).toBe('Settings could not be updated')
    expect(updateErrorMessage(new Error('EPERM: operation not permitted'))).toBe(
      'Settings could not be updated'
    )
  })
})
