import { afterEach, describe, expect, it, vi } from 'vitest'
import { createAppStore } from '@app/store/store'
import { selectSettings, settingsChanged } from '@app/store/settingsSlice'
import { selectActiveTab, selectSidebarOpen, sidebarToggled, tabSelected, wentBack } from '@app/store/uiSlice'
import { selectConnection } from '@app/core/connectionSlice'
import type { CoreConnection, CoreState } from '@shared/core'
import { defaultSettings, type Settings } from '@shared/settings'
import { fakePlatform } from '../../fakePlatform'

// Listener effects run after dispatch returns; one macrotask lets them finish.
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

afterEach(() => {
  vi.restoreAllMocks()
})

describe('app store', () => {
  it('opens on the tab saved in settings', () => {
    const store = createAppStore({
      platform: fakePlatform().platform,
      initialSettings: { ...defaultSettings, lastTab: 'code' }
    })

    expect(selectActiveTab(store.getState())).toBe('code')
  })

  it('opens on Chat when nothing was saved', () => {
    const store = createAppStore({ platform: fakePlatform().platform })

    expect(selectActiveTab(store.getState())).toBe('chat')
  })

  it('saves the new tab as lastTab when the tab changes', async () => {
    const fake = fakePlatform()
    const store = createAppStore({ platform: fake.platform })

    store.dispatch(tabSelected('automations'))
    await settle()

    expect(fake.prefs.update).toHaveBeenCalledOnce()
    expect(fake.prefs.update).toHaveBeenCalledWith({ lastTab: 'automations' })
  })

  it('does not save when the open tab is selected again', async () => {
    const fake = fakePlatform()
    const store = createAppStore({ platform: fake.platform })

    store.dispatch(tabSelected('chat'))
    await settle()

    expect(fake.prefs.update).not.toHaveBeenCalled()
  })

  it('still switches the tab when saving fails', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const fake = fakePlatform()
    fake.prefs.update.mockRejectedValue(new Error('disk full'))
    const store = createAppStore({ platform: fake.platform })

    store.dispatch(tabSelected('automations'))
    await settle()

    expect(selectActiveTab(store.getState())).toBe('automations')
    expect(error).toHaveBeenCalledWith('Could not save the last open tab', expect.any(Error))
  })
})

describe('sidebar state', () => {
  it('opens the way it was left', () => {
    const store = createAppStore({
      platform: fakePlatform().platform,
      initialSettings: { ...defaultSettings, sidebarOpen: false }
    })

    expect(selectSidebarOpen(store.getState())).toBe(false)
  })

  it('saves whether the sidebar is open each time it is toggled', async () => {
    const fake = fakePlatform()
    const store = createAppStore({ platform: fake.platform })

    store.dispatch(sidebarToggled())
    await settle()
    store.dispatch(sidebarToggled())
    await settle()

    expect(fake.prefs.update.mock.calls).toEqual([[{ sidebarOpen: false }], [{ sidebarOpen: true }]])
  })
})

describe('changing settings', () => {
  it('shows the change at once, before it is saved', () => {
    // A save that never finishes: whatever the page shows now came from the optimistic update alone.
    const fake = fakePlatform()
    fake.prefs.update.mockReturnValue(new Promise(() => {}))
    const store = createAppStore({ platform: fake.platform })

    store.dispatch(settingsChanged({ closeAction: 'quit' }))

    expect(selectSettings(store.getState()).closeAction).toBe('quit')
    expect(fake.prefs.update).toHaveBeenCalledWith({ closeAction: 'quit' })
  })

  it('takes what main saved as the truth', async () => {
    const saved = { ...defaultSettings, theme: 'dark' as const, startWithWindows: true }
    const fake = fakePlatform()
    fake.prefs.update.mockResolvedValue(saved)
    const store = createAppStore({ platform: fake.platform })

    store.dispatch(settingsChanged({ theme: 'dark' }))
    await settle()

    expect(selectSettings(store.getState())).toEqual(saved)
  })

  it('puts the old value back when saving fails, so the page never shows a setting that is not saved', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const fake = fakePlatform()
    fake.prefs.update.mockRejectedValue(new Error('disk full'))
    const store = createAppStore({ platform: fake.platform })

    store.dispatch(settingsChanged({ startWithWindows: true }))
    expect(selectSettings(store.getState()).startWithWindows).toBe(true)
    await settle()

    expect(selectSettings(store.getState()).startWithWindows).toBe(false)
  })
})

describe('settings pushed by main', () => {
  it('a push from main replaces the settings slice', () => {
    const fake = fakePlatform()
    const store = createAppStore({ platform: fake.platform })
    const pushed: Settings = { ...defaultSettings, cudaOfferDismissed: true }

    fake.prefs.emit(pushed)

    expect(selectSettings(store.getState())).toEqual(pushed)
  })

  it('a push leaves the open tab and the sidebar as they are', () => {
    const fake = fakePlatform()
    const store = createAppStore({ platform: fake.platform })
    store.dispatch(tabSelected('code'))
    store.dispatch(sidebarToggled())

    fake.prefs.emit({ ...defaultSettings, lastTab: 'automations', sidebarOpen: true })

    expect(selectActiveTab(store.getState())).toBe('code')
    expect(selectSidebarOpen(store.getState())).toBe(false)
  })
})

describe('back and forward', () => {
  it('remembers the tab Back lands on as the last tab, so the app reopens there', async () => {
    const fake = fakePlatform()
    const store = createAppStore({ platform: fake.platform })
    store.dispatch(tabSelected('code'))
    await settle()

    store.dispatch(wentBack())
    await settle()

    expect(fake.prefs.update.mock.calls).toEqual([[{ lastTab: 'code' }], [{ lastTab: 'chat' }]])
  })

  it('saves nothing when there is nowhere to go back to', async () => {
    const fake = fakePlatform()
    const store = createAppStore({ platform: fake.platform })

    store.dispatch(wentBack())
    await settle()

    expect(fake.prefs.update).not.toHaveBeenCalled()
  })

  it('starts each launch with an empty history', () => {
    const store = createAppStore({
      platform: fakePlatform().platform,
      initialSettings: { ...defaultSettings, lastTab: 'code' }
    })

    expect(store.getState().ui).toMatchObject({ activeTab: 'code', back: [], forward: [] })
  })
})

const connection: CoreConnection = { baseUrl: 'http://127.0.0.1:53121', token: 'a'.repeat(64) }
const ready = (to: CoreConnection): CoreState => ({
  status: 'ready',
  port: 53121,
  version: '1.0.0',
  connection: to
})

describe("core's connection", () => {
  it('a ready state pushed by main sets the connection; a starting state clears it', () => {
    const fake = fakePlatform()
    const store = createAppStore({ platform: fake.platform })

    fake.core.emit(ready(connection))
    expect(selectConnection(store.getState())).toEqual(connection)

    fake.core.emit({ status: 'starting' })
    expect(selectConnection(store.getState())).toBeNull()
  })

  it("ignores getState's answer when a newer state was already pushed", async () => {
    const fake = fakePlatform()
    const store = createAppStore({ platform: fake.platform })

    fake.core.emit(ready(connection))
    fake.core.answer({ status: 'starting' })
    await settle()

    expect(selectConnection(store.getState())).toEqual(connection)
  })

  it('keeps the same object when an equal connection is pushed twice', () => {
    const fake = fakePlatform()
    const store = createAppStore({ platform: fake.platform })

    fake.core.emit(ready(connection))
    const first = selectConnection(store.getState())
    fake.core.emit(ready({ ...connection }))

    expect(selectConnection(store.getState())).toBe(first)
  })
})
