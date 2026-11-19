// The Redux store: the single place the UI's shared state lives.
import {
  combineSlices,
  configureStore,
  createListenerMiddleware,
  isAnyOf,
  type EnhancedStore,
  type StoreEnhancer,
  type ThunkDispatch,
  type Tuple,
  type UnknownAction
} from '@reduxjs/toolkit'
import type { CoreState } from '../../../shared/core'
import { defaultSettings, type Settings, type SettingsPatch } from '../../../shared/settings'
import { connectionChanged, connectionSlice } from '../core/connectionSlice'
import { coreApi } from '../core/coreApi'
import type { Platform } from '../platform/platform'
import { followCoreStream } from '../core/stream'
import { settingsChanged, settingsReplaced, settingsSlice } from './settingsSlice'
import { initialUiState, sidebarToggled, tabSelected, uiSlice, wentBack, wentForward } from './uiSlice'

const rootReducer = combineSlices(uiSlice, settingsSlice, connectionSlice, coreApi)

export type RootState = ReturnType<typeof rootReducer>
/** What thunks and listeners get as their extra argument: the host, never window.api. */
export interface AppExtra {
  platform: Platform
}

/** The store's own type: thunks get the platform as their extra argument, named up front to avoid a circular type. */
export type AppStore = EnhancedStore<
  RootState,
  UnknownAction,
  Tuple<[StoreEnhancer<{ dispatch: ThunkDispatch<RootState, AppExtra, UnknownAction> }>, StoreEnhancer]>
>
export type AppDispatch = AppStore['dispatch']

export interface AppStoreOptions {
  /** The host: where changes are saved, and where pushes from main and core arrive. */
  platform: Platform
  /** The settings read at startup, so the app reopens as it was left (tab, sidebar) and Settings shows them. */
  initialSettings?: Settings
}

export function createAppStore({ platform, initialSettings }: AppStoreOptions): AppStore {
  // Reducers must stay pure (no I/O), so saving to disk happens here, after an action has gone through.
  const listener = createListenerMiddleware<RootState, AppDispatch, AppExtra>({ extra: { platform } })

  /** Saves a change; main answers with the whole saved file, which becomes the settings slice. */
  async function save(patch: SettingsPatch, dispatch: (action: UnknownAction) => unknown): Promise<void> {
    dispatch(settingsReplaced(await platform.prefs.update(patch)))
  }

  listener.startListening({
    // Clicking a tab, Back and Forward all change the open tab, and the app should reopen on it.
    matcher: isAnyOf(tabSelected, wentBack, wentForward),
    effect: async (_action, api) => {
      const tab = api.getState().ui.activeTab
      // Selecting the open tab, or Back with no history, changes nothing, so there's nothing to save.
      if (api.getOriginalState().ui.activeTab === tab) return
      try {
        await save({ lastTab: tab }, api.dispatch)
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
  const store = configureStore({
    reducer: rootReducer,
    preloadedState: {
      // History starts empty each launch: Back never leads somewhere from a previous session.
      ui: { ...initialUiState, activeTab: startup.lastTab, sidebarOpen: startup.sidebarOpen },
      settings: startup
    },
    middleware: (getDefault) =>
      getDefault({ thunk: { extraArgument: { platform } satisfies AppExtra } })
        .prepend(listener.middleware)
        .concat(coreApi.middleware)
  })
  // Main may change settings on its own (the CUDA download switches the engine). One store per window, so the
  // subscription lives as long as the window and is never removed. The ui slice is the window's own state.
  platform.prefs.onChange((pushed) => store.dispatch(settingsReplaced(pushed)))
  // Started before core's state arrives, so the first ready state opens the stream. Like the settings
  // subscription, it lives as long as the window.
  followCoreStream({ dispatch: store.dispatch, getState: store.getState, subscribe: store.subscribe })
  followCoreState(platform.core, store.dispatch)
  return store
}

/** Keeps the connection slice in step with core's state, for as long as the window lives. */
function followCoreState(core: Platform['core'], dispatch: AppDispatch): void {
  let received = false
  const apply = (state: CoreState): void => {
    dispatch(connectionChanged(state.status === 'ready' ? state.connection : null))
  }
  // Subscribe before asking: a push that lands while getState is in flight is newer than its answer.
  core.onState((state) => {
    received = true
    apply(state)
  })
  core
    .state()
    .then((state) => {
      if (!received) apply(state)
    })
    .catch((error) => console.error('Could not read the models service state', error))
}
