import { followCoreState } from './core/followCoreState'
import { followCoreStream } from './core/stream'
import { createAppStore, type AppStore, type AppStoreOptions } from './store/store'

/** Builds what the app runs on. Features register their slices and listeners here, as they gain them. */
export function createApp(options: AppStoreOptions): AppStore {
  const { store } = createAppStore(options)
  // The stream first, so the first ready state opens it. Like the settings subscription, both live as long as
  // the window.
  followCoreStream({ dispatch: store.dispatch, getState: store.getState, subscribe: store.subscribe })
  followCoreState(options.platform.core, store.dispatch)
  return store
}
