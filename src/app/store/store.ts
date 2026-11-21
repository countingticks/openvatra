// The Redux store: the single place the UI's shared state lives.
import {
  combineSlices,
  configureStore,
  createListenerMiddleware,
  isAnyOf,
  type EnhancedStore,
  type StoreEnhancer,
  type TypedStartListening,
  type ThunkDispatch,
  type Tuple,
  type UnknownAction
} from '@reduxjs/toolkit'
import { defaultSettings, type Settings, type SettingsPatch } from '@shared/settings'
import { connectionSlice } from '@app/core/connectionSlice'
import { coreApi } from '@app/core/coreApi'
import type { Platform } from '@app/platform/platform'
import { settingsChanged, settingsReplaced, settingsSlice } from './settingsSlice'
import { parseRoute, routePath } from './route'
import {
  initialUiState,
  navigated,
  routeReplaced,
  sidebarToggled,
  tabSelected,
  uiSlice,
  wentBack,
  wentForward
} from './uiSlice'

/** Slices a feature injects when it registers (`declare module` in the feature extends this). */
export interface LazySlices {}

export const rootReducer = combineSlices(
  uiSlice,
  settingsSlice,
  connectionSlice,
  coreApi
).withLazyLoadedSlices<LazySlices>()

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
/** What a feature's sync registrar gets to add its listeners on core's events. */
export type AppStartListening = TypedStartListening<RootState, AppDispatch, AppExtra>

export interface AppStoreOptions {
  /** The host: where changes are saved, and where pushes from main and core arrive. */
  platform: Platform
  /** The settings read at startup, so the app reopens as it was left (tab, sidebar) and Settings shows them. */
  initialSettings?: Settings
}

export function createAppStore({ platform, initialSettings }: AppStoreOptions): {
  store: AppStore
  startListening: AppStartListening
} {
  // Reducers must stay pure (no I/O), so saving to disk happens here, after an action has gone through.
  const listener = createListenerMiddleware<RootState, AppDispatch, AppExtra>({ extra: { platform } })

  /** Saves a change; main answers with the whole saved file, which becomes the settings slice. */
  async function save(patch: SettingsPatch, dispatch: (action: UnknownAction) => unknown): Promise<void> {
    dispatch(settingsReplaced(await platform.prefs.update(patch)))
  }

  listener.startListening({
    // Every move changes the route, and the app should reopen on it.
    matcher: isAnyOf(navigated, routeReplaced, tabSelected, wentBack, wentForward),
    effect: async (_action, api) => {
      const route = api.getState().ui.route
      // Selecting the open tab, or Back with no history, changes nothing, so there's nothing to save.
      if (routePath(api.getOriginalState().ui.route) === routePath(route)) return
      try {
        await save({ lastRoute: routePath(route) }, api.dispatch)
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
  // A saved path that names nothing (an old or edited file) opens on Chat.
  const route = parseRoute(startup.lastRoute) ?? { tab: 'chat' }
  const store = configureStore({
    reducer: rootReducer,
    preloadedState: {
      // History starts empty each launch: Back never leads somewhere from a previous session.
      ui: {
        ...initialUiState,
        route,
        tabRoutes: { ...initialUiState.tabRoutes, [route.tab]: route },
        sidebarOpen: startup.sidebarOpen
      },
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
  return { store, startListening: listener.startListening as AppStartListening }
}
