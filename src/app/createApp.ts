import { registerConfigSync } from './core/configSync'
import { followCoreState } from './core/followCoreState'
import { followCoreStream } from './core/stream'
import { registerModels } from './features/models'
import { registerRuns } from './features/runs'
import { createAppStore, type AppStore, type AppStoreOptions } from './store/store'

/** Builds what the app runs on. Features register their slices and listeners here, as they gain them. */
export function createApp(options: AppStoreOptions): AppStore {
  const { store, startListening } = createAppStore(options)
  // Listeners first, so no frame arrives before the one that applies it. The stream before core's state, so the
  // first ready state opens it. Like the settings subscription, both live as long as the window.
  registerConfigSync(startListening)
  registerModels(startListening)
  registerRuns(startListening)
  followCoreStream({ dispatch: store.dispatch, getState: store.getState, subscribe: store.subscribe })
  followCoreState(options.platform.core, store.dispatch)
  return store
}
