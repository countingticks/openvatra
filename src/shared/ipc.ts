// The complete API the renderer may use, exposed by the preload as `window.api`.
// This file is the trust boundary: the UI can do exactly what is listed here and nothing else.
// Keep it small; every addition must be reviewed (see AGENTS.md, "Ask first").
import type { Settings, SettingsPatch } from './settings'

/** Channel names shared by the preload (sends) and main (answers), so the two can't drift apart. */
export const ipcChannels = {
  settingsGet: 'settings:get',
  settingsUpdate: 'settings:update',
  filesLocations: 'files:locations',
  filesOpenFolder: 'files:open-folder'
} as const

/** The folders the UI may ask to open, by name. The UI never sends a path; main decides where each one is. */
export const appFolders = ['settings', 'logs'] as const
export type AppFolder = (typeof appFolders)[number]

export interface FileLocations {
  /** Full path of settings.json. */
  readonly settingsFile: string
  /** The folder holding main.log. */
  readonly logsFolder: string
}

export interface FilesApi {
  /** Where the app keeps its files, to show in Settings. */
  locations(): Promise<FileLocations>
  /** Opens that folder in File Explorer; rejects if it can't. */
  openFolder(folder: AppFolder): Promise<void>
}

export interface RuntimeInfo {
  /** Operating system, as Node reports it (e.g. 'win32'). */
  readonly platform: string
  readonly versions: {
    readonly electron: string
    readonly chrome: string
    readonly node: string
  }
}

export interface SettingsApi {
  get(): Promise<Settings>
  /** Validates, saves, and resolves with the full new settings; rejects (and saves nothing) if invalid. */
  update(patch: SettingsPatch): Promise<Settings>
}

export interface Api {
  /** Static facts about the running app; safe to read, nothing to change. */
  readonly runtime: RuntimeInfo
  readonly settings: SettingsApi
  readonly files: FilesApi
}
