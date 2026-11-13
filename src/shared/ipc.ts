// The complete API the renderer may use, exposed by the preload as `window.api`.
// This file is the trust boundary: the UI can do exactly what is listed here and nothing else.
// Keep it small; every addition must be reviewed (see AGENTS.md, "Ask first").
import type { CoreState } from './core'
import type { Settings, SettingsPatch } from './settings'

/** Channel names shared by the preload (sends) and main (answers), so the two can't drift apart. */
export const ipcChannels = {
  settingsGet: 'settings:get',
  settingsUpdate: 'settings:update',
  /** Main → UI: sent with the full Settings after every saved change. */
  settingsChanged: 'settings:changed',
  filesLocations: 'files:locations',
  filesOpenFolder: 'files:open-folder',
  filesPick: 'files:pick',
  windowMinimize: 'window:minimize',
  windowToggleMaximize: 'window:toggle-maximize',
  windowClose: 'window:close',
  windowIsMaximized: 'window:is-maximized',
  /** Main → UI: sent with a boolean whenever the window is maximized or restored. */
  windowMaximizedChanged: 'window:maximized-changed',
  windowEdit: 'window:edit',
  appQuit: 'app:quit',
  coreGetState: 'core:get-state',
  /** Main → UI: sent with the new CoreState on every change. */
  coreStateChanged: 'core:state-changed',
  coreRestart: 'core:restart',
  coreOpenLog: 'core:open-log'
} as const

/** The Edit menu's commands, run by Chromium on whatever is focused in the page. */
export const editCommands = ['undo', 'redo', 'cut', 'copy', 'paste', 'selectAll'] as const
export type EditCommand = (typeof editCommands)[number]

export interface AppApi {
  /** Quits OpenVatra (File → Quit, Ctrl+Q), whatever "When I close the window" says. */
  quit(): Promise<void>
}

/** The window's own buttons, drawn by the UI because the native title bar is hidden. */
export interface AppWindowApi {
  minimize(): Promise<void>
  /** Maximizes, or restores if already maximized. */
  toggleMaximize(): Promise<void>
  /** Same as closing the window: hides to the tray or quits, per Settings → When I close the window. */
  close(): Promise<void>
  isMaximized(): Promise<boolean>
  /** Calls back with the new state whenever it changes (double-click on the bar, Aero Snap…); returns unsubscribe. */
  onMaximizedChange(callback: (maximized: boolean) => void): () => void
  /** Runs an Edit menu command on the page's focused element; rejects for anything not in `editCommands`. */
  edit(command: EditCommand): Promise<void>
}

/** The folders the UI may ask to open, by name. The UI never sends a path; main decides where each one is. */
export const appFolders = ['settings', 'logs'] as const
export type AppFolder = (typeof appFolders)[number]

export interface FileLocations {
  /** Full path of settings.json. */
  readonly settingsFile: string
  /** The folder holding main.log. */
  readonly logsFolder: string
}

/** The paths the user can choose in Settings → Models, by name. */
export const pickTargets = ['llamaServer', 'modelsDir'] as const
export type PickTarget = (typeof pickTargets)[number]

export interface FilesApi {
  /** Where the app keeps its files, to show in Settings. */
  locations(): Promise<FileLocations>
  /** Opens that folder in File Explorer; rejects if it can't. */
  openFolder(folder: AppFolder): Promise<void>
  /**
   * Shows Windows' own Open dialog for that path and saves the choice in core. The UI never sends a path:
   * core runs llama-server.exe, so only a file the user picked in the system dialog may become it. true: saved;
   * false: the user cancelled.
   */
  pick(target: PickTarget): Promise<boolean>
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
  /** Calls back with the full settings after every saved change, wherever it came from; returns unsubscribe. */
  onChange(callback: (settings: Settings) => void): () => void
}

/** The models service (core.exe). The UI can watch it and ask for a restart; it never learns its token. */
export interface CoreApi {
  getState(): Promise<CoreState>
  /** Calls back with every new state; returns unsubscribe. */
  onState(callback: (state: CoreState) => void): () => void
  /** Stops core and starts a fresh one; resolves once the new one is launching (watch `onState` for the result). */
  restart(): Promise<void>
  /** Opens main.log in the default app (or shows it in Explorer); rejects if it can't. */
  openLog(): Promise<void>
}

export interface Api {
  /** Static facts about the running app; safe to read, nothing to change. */
  readonly runtime: RuntimeInfo
  readonly settings: SettingsApi
  readonly files: FilesApi
  readonly appWindow: AppWindowApi
  readonly app: AppApi
  readonly core: CoreApi
}
