// Runs in a sandbox before the UI loads. Its only job: hand the UI the API defined in src/shared/ipc.ts.
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { isCoreState } from '../shared/core'
import { type Api, ipcChannels } from '../shared/ipc'
import type { Settings } from '../shared/settings'

const api: Api = {
  runtime: Object.freeze({
    platform: process.platform,
    versions: Object.freeze({
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node
    })
  }),
  // Thin wrappers: only these channels can be reached, and main validates whatever arrives on them.
  settings: Object.freeze({
    get: () => ipcRenderer.invoke(ipcChannels.settingsGet),
    update: (patch) => ipcRenderer.invoke(ipcChannels.settingsUpdate, patch),
    onChange: (callback) => {
      // Main is the only sender, as with get(): only a plain object gets through (no zod in the sandbox).
      const listener = (_event: IpcRendererEvent, settings: unknown): void => {
        if (typeof settings === 'object' && settings !== null && !Array.isArray(settings))
          callback(settings as Settings)
      }
      ipcRenderer.on(ipcChannels.settingsChanged, listener)
      return () => {
        ipcRenderer.removeListener(ipcChannels.settingsChanged, listener)
      }
    }
  }),
  files: Object.freeze({
    locations: () => ipcRenderer.invoke(ipcChannels.filesLocations),
    openFolder: (folder) => ipcRenderer.invoke(ipcChannels.filesOpenFolder, folder),
    pick: (target) => ipcRenderer.invoke(ipcChannels.filesPick, target),
    bundledLlama: () => ipcRenderer.invoke(ipcChannels.filesBundledLlama),
    useBundledLlama: () => ipcRenderer.invoke(ipcChannels.filesUseBundledLlama)
  }),
  appWindow: Object.freeze({
    minimize: () => ipcRenderer.invoke(ipcChannels.windowMinimize),
    toggleMaximize: () => ipcRenderer.invoke(ipcChannels.windowToggleMaximize),
    close: () => ipcRenderer.invoke(ipcChannels.windowClose),
    isMaximized: () => ipcRenderer.invoke(ipcChannels.windowIsMaximized),
    onMaximizedChange: (callback) => {
      // The UI gets only the boolean: handing it the IPC event would give it access to ipcRenderer's sender.
      const listener = (_event: IpcRendererEvent, maximized: unknown): void => {
        if (typeof maximized === 'boolean') callback(maximized)
      }
      ipcRenderer.on(ipcChannels.windowMaximizedChanged, listener)
      return () => {
        ipcRenderer.removeListener(ipcChannels.windowMaximizedChanged, listener)
      }
    },
    edit: (command) => ipcRenderer.invoke(ipcChannels.windowEdit, command)
  }),
  app: Object.freeze({
    quit: () => ipcRenderer.invoke(ipcChannels.appQuit)
  }),
  core: Object.freeze({
    getState: () => ipcRenderer.invoke(ipcChannels.coreGetState),
    onState: (callback) => {
      // Same pattern as onMaximizedChange: no IPC event reaches the UI, and a malformed value is dropped.
      const listener = (_event: IpcRendererEvent, state: unknown): void => {
        if (isCoreState(state)) callback(state)
      }
      ipcRenderer.on(ipcChannels.coreStateChanged, listener)
      return () => {
        ipcRenderer.removeListener(ipcChannels.coreStateChanged, listener)
      }
    },
    restart: () => ipcRenderer.invoke(ipcChannels.coreRestart),
    openLog: () => ipcRenderer.invoke(ipcChannels.coreOpenLog)
  })
}

// contextBridge copies the object into the page's isolated world: the page can call it but can't reach
// anything behind it. There is deliberately no fallback without context isolation.
contextBridge.exposeInMainWorld('api', api)
