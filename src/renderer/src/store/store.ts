// The Redux store: the single place the UI's shared state lives.
import { combineSlices, configureStore, createListenerMiddleware } from '@reduxjs/toolkit'
import type { SettingsApi } from '../../../shared/ipc'
import type { TabId } from '../../../shared/settings'
import { initialUiState, tabSelected, uiSlice } from './uiSlice'

const rootReducer = combineSlices(uiSlice)

export type RootState = ReturnType<typeof rootReducer>
/** configureStore's own result type for our state (thunk-capable dispatch), named up front for the return type. */
export type AppStore = ReturnType<typeof configureStore<RootState>>
export type AppDispatch = AppStore['dispatch']

export interface AppStoreOptions {
  /** Where the last open tab is saved. Passed in (not read from window.api) so tests can hand in a fake. */
  settings: Pick<SettingsApi, 'update'>
  /** The tab saved in settings, so the app reopens where it was left. */
  initialTab?: TabId
}

export function createAppStore({ settings, initialTab }: AppStoreOptions): AppStore {
  // Reducers must stay pure (no I/O), so saving to disk happens here, after an action has gone through.
  const listener = createListenerMiddleware<RootState>()
  listener.startListening({
    actionCreator: tabSelected,
    effect: async (action, api) => {
      // Selecting the tab that is already open changes nothing, so there's nothing to save.
      if (api.getOriginalState().ui.activeTab === action.payload) return
      try {
        await settings.update({ lastTab: action.payload })
      } catch (error) {
        // The tab still switches; only remembering it for next launch failed.
        console.error('Could not save the last open tab', error)
      }
    }
  })

  return configureStore({
    reducer: rootReducer,
    preloadedState: { ui: { ...initialUiState, activeTab: initialTab ?? initialUiState.activeTab } },
    middleware: (getDefault) => getDefault().prepend(listener.middleware)
  })
}
