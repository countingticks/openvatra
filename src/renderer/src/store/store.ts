// The Redux store: the single place the UI's shared state lives.
import { combineSlices, configureStore, createListenerMiddleware, type UnknownAction } from '@reduxjs/toolkit'
import type { SettingsApi } from '../../../shared/ipc'
import { defaultSettings, type Settings, type SettingsPatch } from '../../../shared/settings'
import { settingsChanged, settingsReplaced, settingsSlice } from './settingsSlice'
import { sidebarToggled, tabSelected, uiSlice } from './uiSlice'

const rootReducer = combineSlices(uiSlice, settingsSlice)

export type RootState = ReturnType<typeof rootReducer>
/** configureStore's own result type for our state (thunk-capable dispatch), named up front for the return type. */
export type AppStore = ReturnType<typeof configureStore<RootState>>
export type AppDispatch = AppStore['dispatch']

export interface AppStoreOptions {
  /** Where changes are saved. Passed in (not read from window.api) so tests can hand in a fake. */
  settings: Pick<SettingsApi, 'update'>
  /** The settings read at startup, so the app reopens as it was left (tab, sidebar) and Settings shows them. */
  initialSettings?: Settings
}

export function createAppStore({ settings, initialSettings }: AppStoreOptions): AppStore {
  // Reducers must stay pure (no I/O), so saving to disk happens here, after an action has gone through.
  const listener = createListenerMiddleware<RootState>()

  /** Saves a change; main answers with the whole saved file, which becomes the settings slice. */
  async function save(patch: SettingsPatch, dispatch: (action: UnknownAction) => unknown): Promise<void> {
    dispatch(settingsReplaced(await settings.update(patch)))
  }

  listener.startListening({
    actionCreator: tabSelected,
    effect: async (action, api) => {
      // Selecting the tab that is already open changes nothing, so there's nothing to save.
      if (api.getOriginalState().ui.activeTab === action.payload) return
      try {
        await save({ lastTab: action.payload }, api.dispatch)
      } catch (error) {
        // The tab still switches; only remembering it for next launch failed.
        console.error('Could not save the last open tab', error)
      }
    }
  })

  listener.startListening({
    actionCreator: sidebarToggled,
    effect: async (_action, api) => {
      try {
        await save({ sidebarOpen: api.getState().ui.sidebarOpen }, api.dispatch)
      } catch (error) {
        console.error('Could not save whether the sidebar is open', error)
      }
    }
  })

  listener.startListening({
    actionCreator: settingsChanged,
    effect: async (action, api) => {
      // getOriginalState only works before the first await, so take the values to fall back to now.
      const previous = api.getOriginalState().settings
      try {
        await save(action.payload, api.dispatch)
      } catch (error) {
        // The page already shows the change; put back what is really saved, so it never lies.
        console.error('Could not save settings', error)
        api.dispatch(settingsReplaced(previous))
      }
    }
  })

  const startup = initialSettings ?? structuredClone(defaultSettings)
  return configureStore({
    reducer: rootReducer,
    preloadedState: {
      ui: { activeTab: startup.lastTab, sidebarOpen: startup.sidebarOpen },
      settings: startup
    },
    middleware: (getDefault) => getDefault().prepend(listener.middleware)
  })
}
