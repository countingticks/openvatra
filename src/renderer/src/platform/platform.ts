import type { CoreState } from '../../../shared/core'
import type { AppWindowApi, FilesApi, SettingsApi } from '../../../shared/ipc'

/** Everything the UI needs from the host it runs in. The desktop shell fills all of it; a host may leave out the optional parts. */
export interface Platform {
  kind: 'desktop' | 'web'
  /** How to reach core, and changes to it. restart/openLog: desktop only. */
  core: {
    state(): Promise<CoreState>
    onState(callback: (state: CoreState) => void): () => void
    restart?(): Promise<void>
    openLog?(): Promise<void>
  }
  /** The host's own preferences (desktop: settings.json through main). */
  prefs: SettingsApi
  /** Desktop only: our own title bar buttons and the Edit commands. */
  window?: AppWindowApi
  /** Desktop only: pickers and opening folders. */
  files?: FilesApi
  /** Desktop only. */
  quit?(): Promise<void>
}
