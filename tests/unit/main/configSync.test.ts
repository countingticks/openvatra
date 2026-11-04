// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { createConfigSync, toCoreConfig } from '../../../src/main/core/configSync'
import { defaultSettings, type Settings } from '../../../src/shared/settings'

const bundled = 'C:/app/resources/llama/llama-server.exe'
const defaultDir = 'C:/Users/me/OpenVatra/Models'

const withModels = (models: Partial<Settings['models']>): Settings => ({
  ...defaultSettings,
  models: { ...defaultSettings.models, ...models }
})

describe('toCoreConfig', () => {
  it('turns "not chosen" into core\'s empty values and argument text into lists', () => {
    const models = {
      ...defaultSettings.models,
      idleUnloadMinutes: null,
      options: { qwen: { args: '-c 4096 --alias "my qwen"' }, gemma: {} }
    }
    expect(toCoreConfig(models, bundled, defaultDir)).toEqual({
      llamaServerPath: bundled,
      modelsDir: defaultDir,
      embeddingModel: '',
      idleUnloadMinutes: 0,
      options: {
        qwen: { args: ['-c', '4096', '--alias', 'my qwen'] },
        gemma: { args: [] }
      }
    })
  })

  it('uses the default models folder until the user chose one', () => {
    const chosen = { ...defaultSettings.models, modelsDir: 'D:/models' }

    expect(toCoreConfig(defaultSettings.models, bundled, defaultDir)).toMatchObject({ modelsDir: defaultDir })
    expect(toCoreConfig(chosen, bundled, defaultDir)).toMatchObject({ modelsDir: 'D:/models' })
  })

  it('runs the bundled llama-server unless the user chose their own', () => {
    const own = { ...defaultSettings.models, llamaServerPath: 'D:/llama/llama-server.exe' }

    expect(toCoreConfig(defaultSettings.models, bundled, defaultDir)).toMatchObject({
      llamaServerPath: bundled
    })
    expect(toCoreConfig(own, bundled, defaultDir)).toMatchObject({
      llamaServerPath: 'D:/llama/llama-server.exe'
    })
  })
})

describe('config sync', () => {
  const log = { warn: vi.fn() }

  it('sends the current models settings to /api/config', async () => {
    const post = vi.fn().mockResolvedValue(undefined)
    const settings = withModels({ modelsDir: 'D:/models', idleUnloadMinutes: 60 })

    await createConfigSync(
      () => settings,
      post,
      log,
      async () => bundled,
      defaultDir
    ).sync()

    expect(post).toHaveBeenCalledWith(
      '/api/config',
      expect.objectContaining({ modelsDir: 'D:/models', idleUnloadMinutes: 60 })
    )
  })

  it('syncs when models changed, and ignores other settings changes', async () => {
    const post = vi.fn().mockResolvedValue(undefined)
    const sync = createConfigSync(
      () => defaultSettings,
      post,
      log,
      async () => bundled,
      defaultDir
    )

    sync.onSettingsChange({ ...defaultSettings, theme: 'dark' }, defaultSettings)
    expect(post).not.toHaveBeenCalled()

    sync.onSettingsChange(withModels({ embeddingModel: 'bge' }), defaultSettings)
    await vi.waitFor(() => expect(post).toHaveBeenCalledTimes(1))
  })

  it('logs a failure instead of throwing, and keeps working afterwards', async () => {
    const post = vi.fn().mockRejectedValueOnce(new Error('core is not ready')).mockResolvedValue(undefined)
    const sync = createConfigSync(
      () => defaultSettings,
      post,
      log,
      async () => bundled,
      defaultDir
    )

    await expect(sync.sync()).resolves.toBeUndefined()
    expect(log.warn).toHaveBeenCalled()
    await sync.sync()
    expect(post).toHaveBeenCalledTimes(2)
  })

  it('sends one after another, a later change is sent after the earlier one, never before', async () => {
    let current = withModels({ modelsDir: 'one' })
    const bodies: unknown[] = []
    let release: () => void = () => {}
    const post = vi.fn(async (_path: string, body: unknown) => {
      bodies.push(body)
      if (bodies.length === 1) await new Promise<void>((resolve) => (release = resolve))
    })
    const sync = createConfigSync(
      () => current,
      post,
      log,
      async () => bundled,
      defaultDir
    )

    const first = sync.sync()
    await vi.waitFor(() => expect(post).toHaveBeenCalledTimes(1))
    current = withModels({ modelsDir: 'two' })
    const second = sync.sync()
    await Promise.resolve()
    expect(post).toHaveBeenCalledTimes(1) // the second waits for the first
    release()
    await Promise.all([first, second])

    expect(bodies.map((body) => (body as { modelsDir: string }).modelsDir)).toEqual(['one', 'two'])
  })
})
