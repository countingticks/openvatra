// @vitest-environment node
import { describe, expect, it, type Mock, vi } from 'vitest'
import type { saveSettings } from '../../../src/main/settings'
import { createSettingsStore } from '../../../src/main/settingsStore'
import { defaultSettings, type Settings } from '../../../src/shared/settings'

const filePath = 'D:/data/settings.json'

type Save = typeof saveSettings

function setUp(save: Mock<Save> = vi.fn<Save>(async () => undefined)): {
  store: ReturnType<typeof createSettingsStore>
  save: Mock<Save>
} {
  return { store: createSettingsStore(filePath, { ...defaultSettings }, save), save }
}

describe('createSettingsStore', () => {
  it('saves a valid change, then makes it current', async () => {
    const { store, save } = setUp()

    const updated = await store.update({ theme: 'dark' })

    const expected = { ...defaultSettings, theme: 'dark' }
    expect(updated).toEqual(expected)
    expect(store.get()).toEqual(expected)
    expect(save).toHaveBeenCalledWith(filePath, expected)
  })

  it('rejects an invalid change without saving it', async () => {
    const { store, save } = setUp()

    await expect(store.update({ window: { x: 0, y: 0, width: 900, height: 600 } })).rejects.toThrow()

    expect(save).not.toHaveBeenCalled()
    expect(store.get()).toEqual(defaultSettings)
  })

  it('keeps the old value when saving fails, and still accepts later changes', async () => {
    const save = vi.fn<Save>(async () => undefined).mockRejectedValueOnce(new Error('disk full'))
    const { store } = setUp(save)

    await expect(store.update({ theme: 'dark' })).rejects.toThrow('disk full')
    expect(store.get().theme).toBe('system')

    await store.update({ theme: 'light' })
    expect(store.get().theme).toBe('light')
  })

  it('treats an undefined value as no change', async () => {
    const { store } = setUp()
    await store.update({ theme: 'dark' })

    await store.update({ theme: undefined, lastTab: 'code' })

    expect(store.get()).toEqual({ ...defaultSettings, theme: 'dark', lastTab: 'code' })
  })

  it('merges a models change into the saved models', async () => {
    const { store } = setUp()
    await store.setModelPath('modelsDir', 'D:/models')

    await store.update({ models: { embeddingModel: 'nomic' } })

    expect(store.get().models).toEqual({
      ...defaultSettings.models,
      modelsDir: 'D:/models',
      embeddingModel: 'nomic'
    })
  })

  it('sets a model path from main, which the UI patch cannot', async () => {
    const { store, save } = setUp()

    await store.setModelPath('llamaServerPath', 'C:/llama/llama-server.exe')

    expect(store.get().models.llamaServerPath).toBe('C:/llama/llama-server.exe')
    expect(save).toHaveBeenLastCalledWith(filePath, store.get())
    await expect(store.update({ models: { llamaServerPath: 'C:/evil.exe' } })).rejects.toThrow()
  })

  it('goes back to the bundled llama-server when main clears the path', async () => {
    const { store } = setUp()
    await store.setModelPath('llamaServerPath', 'C:/llama/llama-server.exe')

    await store.setModelPath('llamaServerPath', null)

    expect(store.get().models.llamaServerPath).toBeNull()
  })

  it('saves one change at a time, in the order they were made', async () => {
    let finishFirstSave = (): void => {}
    const saves: Settings[] = []
    const save = vi.fn<Save>(async (_path, settings) => {
      saves.push(settings)
      if (saves.length === 1) await new Promise<void>((resolve) => (finishFirstSave = resolve))
    })
    const { store } = setUp(save)

    const first = store.update({ theme: 'dark' })
    const second = store.update({ lastTab: 'code' })
    await vi.waitFor(() => expect(saves).toHaveLength(1))
    finishFirstSave()
    await Promise.all([first, second])

    // The second save started only after the first finished, and built on its result.
    expect(saves).toEqual([
      { ...defaultSettings, theme: 'dark' },
      { ...defaultSettings, theme: 'dark', lastTab: 'code' }
    ])
    expect(store.get()).toEqual({ ...defaultSettings, theme: 'dark', lastTab: 'code' })
  })

  it('saves window bounds set by the main process', async () => {
    const { store, save } = setUp()
    const bounds = { x: -1500, y: 100, width: 1000, height: 700 }

    await store.setWindowBounds(bounds)

    expect(store.get().window).toEqual(bounds)
    expect(save).toHaveBeenCalledWith(filePath, { ...defaultSettings, window: bounds })
  })

  it('rejects window bounds below the minimum size', async () => {
    const { store, save } = setUp()

    await expect(store.setWindowBounds({ x: 0, y: 0, width: 300, height: 200 })).rejects.toThrow()

    expect(save).not.toHaveBeenCalled()
    expect(store.get().window).toBeUndefined()
  })

  it('remembers that the close-to-tray notice was shown', async () => {
    const { store, save } = setUp()

    await store.markCloseToTrayNoticeShown()

    expect(store.get().closeToTrayNoticeShown).toBe(true)
    expect(save).toHaveBeenCalledWith(filePath, { ...defaultSettings, closeToTrayNoticeShown: true })
  })

  it('tells change listeners the new and previous settings, after saving', async () => {
    const { store, save } = setUp()
    const listener = vi.fn(() => expect(save).toHaveBeenCalledOnce())
    store.onChange(listener)

    await store.update({ startWithWindows: true })

    expect(listener).toHaveBeenCalledExactlyOnceWith(
      { ...defaultSettings, startWithWindows: true },
      defaultSettings
    )
  })

  it('does not tell listeners about a change that failed to save', async () => {
    const save = vi.fn<Save>(async () => undefined).mockRejectedValueOnce(new Error('disk full'))
    const { store } = setUp(save)
    const listener = vi.fn()
    store.onChange(listener)

    await expect(store.update({ startWithWindows: true })).rejects.toThrow('disk full')

    expect(listener).not.toHaveBeenCalled()
  })

  it('stops calling a listener once it unsubscribes', async () => {
    const { store } = setUp()
    const listener = vi.fn()
    const unsubscribe = store.onChange(listener)

    unsubscribe()
    await store.update({ theme: 'dark' })

    expect(listener).not.toHaveBeenCalled()
  })

  it('whenIdle waits for every save asked for so far, even failed ones', async () => {
    let finishSave = (): void => {}
    const save = vi.fn<Save>(() => new Promise<void>((resolve) => (finishSave = resolve)))
    const { store } = setUp(save)
    const failing = store.update({ theme: 'nope' }).catch(() => undefined)
    const saving = store.setWindowBounds({ x: 0, y: 0, width: 900, height: 600 })

    let idle = false
    const whenIdle = store.whenIdle().then(() => (idle = true))
    await vi.waitFor(() => expect(save).toHaveBeenCalledOnce())
    expect(idle).toBe(false)

    finishSave()
    await Promise.all([failing, saving, whenIdle])
    expect(idle).toBe(true)
  })

  it('hands out copies, so callers cannot change its state', () => {
    const { store } = setUp()
    store.get().theme = 'dark'
    expect(store.get().theme).toBe('system')
  })
})
