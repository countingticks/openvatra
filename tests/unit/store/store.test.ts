import { afterEach, describe, expect, it, vi, type Mock } from 'vitest'
import { createAppStore } from '@renderer/store/store'
import { selectSettings, settingsChanged } from '@renderer/store/settingsSlice'
import { selectActiveTab, selectSidebarOpen, sidebarToggled, tabSelected } from '@renderer/store/uiSlice'
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
    const store = createAppStore({
      settings: fakeSettings(),
      initialSettings: { ...defaultSettings, lastTab: 'code' }
    })

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
    const store = createAppStore({ settings })

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

describe('sidebar state', () => {
  it('opens the way it was left', () => {
    const store = createAppStore({
      settings: fakeSettings(),
      initialSettings: { ...defaultSettings, sidebarOpen: false }
    })

    expect(selectSidebarOpen(store.getState())).toBe(false)
  })

  it('saves whether the sidebar is open each time it is toggled', async () => {
    const settings = fakeSettings()
    const store = createAppStore({ settings })

    store.dispatch(sidebarToggled())
    await settle()
    store.dispatch(sidebarToggled())
    await settle()

    expect(settings.update.mock.calls).toEqual([[{ sidebarOpen: false }], [{ sidebarOpen: true }]])
  })
})

describe('changing settings', () => {
  it('shows the change at once, before it is saved', () => {
    // A save that never finishes: whatever the page shows now came from the optimistic update alone.
    const settings = { update: vi.fn<SettingsApi['update']>(() => new Promise(() => {})) }
    const store = createAppStore({ settings })

    store.dispatch(settingsChanged({ closeAction: 'quit' }))

    expect(selectSettings(store.getState()).closeAction).toBe('quit')
    expect(settings.update).toHaveBeenCalledWith({ closeAction: 'quit' })
  })

  it('takes what main saved as the truth', async () => {
    const saved = { ...defaultSettings, theme: 'dark' as const, startWithWindows: true }
    const settings = { update: vi.fn<SettingsApi['update']>().mockResolvedValue(saved) }
    const store = createAppStore({ settings })

    store.dispatch(settingsChanged({ theme: 'dark' }))
    await settle()

    expect(selectSettings(store.getState())).toEqual(saved)
  })

  it('puts the old value back when saving fails, so the page never shows a setting that is not saved', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const settings = { update: vi.fn<SettingsApi['update']>().mockRejectedValue(new Error('disk full')) }
    const store = createAppStore({ settings })

    store.dispatch(settingsChanged({ startWithWindows: true }))
    expect(selectSettings(store.getState()).startWithWindows).toBe(true)
    await settle()

    expect(selectSettings(store.getState()).startWithWindows).toBe(false)
  })
})
