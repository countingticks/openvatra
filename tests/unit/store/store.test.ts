import { afterEach, describe, expect, it, vi, type Mock } from 'vitest'
import { createAppStore } from '@renderer/store/store'
import { selectActiveTab, tabSelected } from '@renderer/store/uiSlice'
import type { SettingsApi } from '../../../src/shared/ipc'
import { defaultSettings } from '../../../src/shared/settings'

// Stands in for window.api.settings: records what the store asks to save. Typed like the real update, so the
// fake can't drift from the API it replaces.
function fakeSettings(): { update: Mock<SettingsApi['update']> } {
  return { update: vi.fn<SettingsApi['update']>().mockResolvedValue(defaultSettings) }
}

// Listener effects run after dispatch returns; one macrotask lets them finish.
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

afterEach(() => {
  vi.restoreAllMocks()
})

describe('app store', () => {
  it('opens on the tab saved in settings', () => {
    const store = createAppStore({ settings: fakeSettings(), initialTab: 'code' })

    expect(selectActiveTab(store.getState())).toBe('code')
  })

  it('opens on Chat when nothing was saved', () => {
    const store = createAppStore({ settings: fakeSettings() })

    expect(selectActiveTab(store.getState())).toBe('chat')
  })

  it('saves the new tab as lastTab when the tab changes', async () => {
    const settings = fakeSettings()
    const store = createAppStore({ settings })

    store.dispatch(tabSelected('automations'))
    await settle()

    expect(settings.update).toHaveBeenCalledOnce()
    expect(settings.update).toHaveBeenCalledWith({ lastTab: 'automations' })
  })

  it('does not save when the open tab is selected again', async () => {
    const settings = fakeSettings()
    const store = createAppStore({ settings, initialTab: 'chat' })

    store.dispatch(tabSelected('chat'))
    await settle()

    expect(settings.update).not.toHaveBeenCalled()
  })

  it('still switches the tab when saving fails', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const settings = { update: vi.fn<SettingsApi['update']>().mockRejectedValue(new Error('disk full')) }
    const store = createAppStore({ settings })

    store.dispatch(tabSelected('settings'))
    await settle()

    expect(selectActiveTab(store.getState())).toBe('settings')
    expect(error).toHaveBeenCalledWith('Could not save the last open tab', expect.any(Error))
  })
})
