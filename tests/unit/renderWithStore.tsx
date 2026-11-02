// Renders UI inside a real Redux store, so component tests exercise the actual reducers. Only the IPC to the main
// process is faked: settings answer like main does (with the whole saved file), and window.api.files answers with
// example paths. tests/setup.ts removes the fake window.api after each test.
import { render, type RenderResult } from '@testing-library/react'
import { Provider } from 'react-redux'
import { vi, type Mock } from 'vitest'
import { createAppStore, type AppStore } from '@renderer/store/store'
import type { Api, FileLocations, FilesApi, SettingsApi } from '../../src/shared/ipc'
import { defaultSettings, type Settings } from '../../src/shared/settings'

export const exampleLocations: FileLocations = {
  settingsFile: 'C:\\Users\\ana\\AppData\\Roaming\\OpenVatra\\settings.json',
  logsFolder: 'C:\\Users\\ana\\AppData\\Roaming\\OpenVatra\\logs'
}

interface Rendered extends RenderResult {
  store: AppStore
  saveSettings: Mock<SettingsApi['update']>
  openFolder: Mock<FilesApi['openFolder']>
}

export function renderWithStore(ui: React.ReactElement, saved: Partial<Settings> = {}): Rendered {
  let current: Settings = { ...defaultSettings, ...saved }
  const saveSettings = vi.fn<SettingsApi['update']>(async (patch) => (current = { ...current, ...patch }))
  const openFolder = vi.fn<FilesApi['openFolder']>().mockResolvedValue(undefined)
  const api: Pick<Api, 'files'> = {
    files: { locations: vi.fn<FilesApi['locations']>().mockResolvedValue(exampleLocations), openFolder }
  }
  vi.stubGlobal('api', api)

  const store = createAppStore({ settings: { update: saveSettings }, initialSettings: current })
  return { store, saveSettings, openFolder, ...render(<Provider store={store}>{ui}</Provider>) }
}
