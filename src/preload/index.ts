// Runs in a sandbox before the UI loads. Its only job: hand the UI the API defined in src/shared/ipc.ts.
import { contextBridge } from 'electron'
import type { Api } from '../shared/ipc'

const api: Api = {
  runtime: Object.freeze({
    platform: process.platform,
    versions: Object.freeze({
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node
    })
  })
}

// contextBridge copies the object into the page's isolated world: the page can call it but can't reach
// anything behind it. There is deliberately no fallback without context isolation.
contextBridge.exposeInMainWorld('api', api)
