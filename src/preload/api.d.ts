import type { Api } from '../shared/ipc'

declare global {
  interface Window {
    /** Everything the UI may ask of the app; see src/shared/ipc.ts. */
    readonly api: Api
  }
}
