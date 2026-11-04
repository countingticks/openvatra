// The complete API the renderer may use, exposed by the preload as `window.api`.
// This file is the trust boundary: the UI can do exactly what is listed here and nothing else.
// Keep it small; every addition must be reviewed (see AGENTS.md, "Ask first").
import type { CoreState, ModelInfo } from './core'
import type { Settings, SettingsPatch } from './settings'
import type { CatalogView, DownloadItem, HardwareReport } from './setup'

/** Channel names shared by the preload (sends) and main (answers), so the two can't drift apart. */
export const ipcChannels = {
  settingsGet: 'settings:get',
  settingsUpdate: 'settings:update',
  filesLocations: 'files:locations',
  filesOpenFolder: 'files:open-folder',
  filesPick: 'files:pick',
  filesBundledLlama: 'files:bundled-llama',
  filesUseBundledLlama: 'files:use-bundled-llama',
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
  coreOpenLog: 'core:open-log',
  coreGetModels: 'core:get-models',
  /** Main → UI: sent with the new ModelInfo[] on every change. */
  coreModelsChanged: 'core:models-changed',
  coreLoad: 'core:load',
  coreUnload: 'core:unload',
  setupHardware: 'setup:hardware',
  setupCatalog: 'setup:catalog',
  setupDownload: 'setup:download',
  setupDownloadEngine: 'setup:download-engine',
  setupCancel: 'setup:cancel',
  setupResume: 'setup:resume',
  setupRemove: 'setup:remove',
  setupGetDownloads: 'setup:get-downloads',
  /** Main → UI: sent with the whole DownloadItem[] queue on every change. */
  setupDownloadsChanged: 'setup:downloads-changed'
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
   * Shows Windows' own Open dialog for that path and saves the choice. The UI never sends a path: core runs
   * llama-server.exe, so only a file the user picked in the system dialog may become it. Resolves with the saved
   * settings, or null if the user cancelled.
   */
  pick(target: PickTarget): Promise<Settings | null>
  /** The engines: the bundled build's release tag (e.g. "b12078", null if unreadable) and the CUDA build's state. */
  bundledLlama(): Promise<LlamaInfo>
  /** Goes back to the bundled llama-server (saves "none chosen"); resolves with the saved settings. */
  useBundledLlama(): Promise<Settings>
}

/** `cuda`: `ready` = installed for this app's tag; `stale` = only an older one (offer the update); `none`. */
export interface LlamaInfo {
  tag: string | null
  cuda: 'none' | 'ready' | 'stale'
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

/** The models service (core.exe). The UI can watch it and ask for a restart; it never learns its token. */
export interface CoreApi {
  getState(): Promise<CoreState>
  /** Calls back with every new state; returns unsubscribe. */
  onState(callback: (state: CoreState) => void): () => void
  /** Stops core and starts a fresh one; resolves once the new one is launching (watch `onState` for the result). */
  restart(): Promise<void>
  /** Opens main.log in the default app (or shows it in Explorer); rejects if it can't. */
  openLog(): Promise<void>
  /** Every model in the models folder with its state; empty while core isn't ready. */
  models(): Promise<ModelInfo[]>
  /** Calls back with the whole list on every change; returns unsubscribe. */
  onModels(callback: (models: ModelInfo[]) => void): () => void
  /** Loads a model; resolves once it is ready (can take minutes), rejects with a short reason. */
  load(id: string): Promise<void>
  /** Asks for a model to be unloaded; it stops in the background (watch `onModels`). */
  unload(id: string): Promise<void>
}

/** First-run model setup: what this PC can run, the models on offer, and getting one onto the disk. */
export interface SetupApi {
  hardware(): Promise<HardwareReport>
  catalog(): Promise<CatalogView>
  /** Queues a catalog model for download; rejects with core's short reason (no space, already installed…). */
  download(catalogId: string): Promise<void>
  /** Queues the faster engine for NVIDIA cards (the CUDA build); same queue and events, id `engine-cuda`. */
  downloadEngine(): Promise<void>
  /** Cancels a download and deletes its partial file. */
  cancel(id: string): Promise<void>
  /** Continues a paused or failed download. */
  resume(id: string): Promise<void>
  /** The queue as it is now; `onDownloads` only tells about changes after this. */
  downloads(): Promise<DownloadItem[]>
  /** Calls back with the whole queue on every change; returns unsubscribe. */
  onDownloads(callback: (items: DownloadItem[]) => void): () => void
  /** Moves a downloaded catalog model's folder to the Recycle Bin (unloading it first). */
  remove(catalogId: string): Promise<void>
}

export interface Api {
  /** Static facts about the running app; safe to read, nothing to change. */
  readonly runtime: RuntimeInfo
  readonly settings: SettingsApi
  readonly files: FilesApi
  readonly appWindow: AppWindowApi
  readonly app: AppApi
  readonly core: CoreApi
  readonly setup: SetupApi
}
