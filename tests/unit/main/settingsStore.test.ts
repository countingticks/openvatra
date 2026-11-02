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

  it('hands out copies, so callers cannot change its state', () => {
    const { store } = setUp()
    store.get().theme = 'dark'
    expect(store.get().theme).toBe('system')
  })
})
