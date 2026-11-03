// Renders UI inside a real Redux store, so component tests exercise the actual reducers. Only the IPC to the main
// process is faked: settings answer like main does (with the whole saved file), window.api.files answers with
// example paths, and window.api.appWindow records the window buttons and can report maximize changes the way main
// would. tests/setup.ts removes the fake window.api after each test.
import { act, render, type RenderResult } from '@testing-library/react'
import { Provider } from 'react-redux'
import { vi, type Mock } from 'vitest'
import { createAppStore, type AppStore } from '@renderer/store/store'
import type { Api, AppWindowApi, FileLocations, FilesApi, SettingsApi } from '../../src/shared/ipc'
import { defaultSettings, type Settings } from '../../src/shared/settings'

export const exampleLocations: FileLocations = {
  settingsFile: 'C:\\Users\\ana\\AppData\\Roaming\\OpenVatra\\settings.json',
  logsFolder: 'C:\\Users\\ana\\AppData\\Roaming\\OpenVatra\\logs'
}

/** The fake window API, plus a way to play main's part. */
export interface FakeAppWindow {
  minimize: Mock<AppWindowApi['minimize']>
  toggleMaximize: Mock<AppWindowApi['toggleMaximize']>
  close: Mock<AppWindowApi['close']>
  /** Report a new maximized state, as main does on maximize / restore. */
  emitMaximized(maximized: boolean): void
  /** How many components are listening right now. */
  listeners(): number
}

interface Rendered extends RenderResult {
  store: AppStore
  saveSettings: Mock<SettingsApi['update']>
  openFolder: Mock<FilesApi['openFolder']>
  appWindow: FakeAppWindow
}

interface Options {
  /** The window starts maximized. */
  maximized?: boolean
}

function fakeAppWindow(startMaximized: boolean): { api: AppWindowApi; fake: FakeAppWindow } {
  const listeners = new Set<(maximized: boolean) => void>()
  const fake: FakeAppWindow = {
    minimize: vi.fn<AppWindowApi['minimize']>().mockResolvedValue(undefined),
    toggleMaximize: vi.fn<AppWindowApi['toggleMaximize']>().mockResolvedValue(undefined),
    close: vi.fn<AppWindowApi['close']>().mockResolvedValue(undefined),
    emitMaximized: (maximized) => act(() => listeners.forEach((listener) => listener(maximized))),
    listeners: () => listeners.size
  }
  const api: AppWindowApi = {
    minimize: fake.minimize,
    toggleMaximize: fake.toggleMaximize,
    close: fake.close,
    isMaximized: vi.fn<AppWindowApi['isMaximized']>().mockResolvedValue(startMaximized),
    onMaximizedChange: (callback) => {
      listeners.add(callback)
      return () => listeners.delete(callback)
    }
  }
  return { api, fake }
}

export function renderWithStore(
  ui: React.ReactElement,
  saved: Partial<Settings> = {},
  options: Options = {}
): Rendered {
  let current: Settings = { ...defaultSettings, ...saved }
  const saveSettings = vi.fn<SettingsApi['update']>(async (patch) => (current = { ...current, ...patch }))
  const openFolder = vi.fn<FilesApi['openFolder']>().mockResolvedValue(undefined)
  const appWindow = fakeAppWindow(options.maximized ?? false)
  const api: Pick<Api, 'files' | 'appWindow'> = {
    files: { locations: vi.fn<FilesApi['locations']>().mockResolvedValue(exampleLocations), openFolder },
    appWindow: appWindow.api
  }
  vi.stubGlobal('api', api)

  const store = createAppStore({ settings: { update: saveSettings }, initialSettings: current })
  return {
    store,
    saveSettings,
    openFolder,
    appWindow: appWindow.fake,
    ...render(<Provider store={store}>{ui}</Provider>)
  }
}
