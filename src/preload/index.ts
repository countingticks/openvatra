// Runs in a sandbox before the UI loads. Its only job: hand the UI the API defined in src/shared/ipc.ts.
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { type Api, ipcChannels } from '../shared/ipc'

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
    update: (patch) => ipcRenderer.invoke(ipcChannels.settingsUpdate, patch)
  }),
  files: Object.freeze({
    locations: () => ipcRenderer.invoke(ipcChannels.filesLocations),
    openFolder: (folder) => ipcRenderer.invoke(ipcChannels.filesOpenFolder, folder)
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
    }
  })
}

// contextBridge copies the object into the page's isolated world: the page can call it but can't reach
// anything behind it. There is deliberately no fallback without context isolation.
contextBridge.exposeInMainWorld('api', api)
