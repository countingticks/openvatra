import { createAppStore, type AppStore, type AppStoreOptions } from './store/store'

/** Builds what the app runs on. Features register their slices and listeners here, as they gain them. */
export function createApp(options: AppStoreOptions): AppStore {
  return createAppStore(options)
}
