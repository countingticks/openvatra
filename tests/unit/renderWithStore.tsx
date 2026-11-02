// Renders UI inside a real Redux store, so component tests exercise the actual reducers. Only the settings API
// (IPC to the main process) is faked.
import { render, type RenderResult } from '@testing-library/react'
import { Provider } from 'react-redux'
import { vi, type Mock } from 'vitest'
import { createAppStore, type AppStore } from '@renderer/store/store'
import type { SettingsApi } from '../../src/shared/ipc'
import { defaultSettings, type TabId } from '../../src/shared/settings'

interface Rendered extends RenderResult {
  store: AppStore
  saveSettings: Mock<SettingsApi['update']>
}

export function renderWithStore(ui: React.ReactElement, initialTab?: TabId): Rendered {
  const saveSettings = vi.fn<SettingsApi['update']>().mockResolvedValue(defaultSettings)
  const store = createAppStore({ settings: { update: saveSettings }, initialTab })
  return { store, saveSettings, ...render(<Provider store={store}>{ui}</Provider>) }
}
