// Model setup through core: hardware, the catalog, downloads and removing a downloaded model. Everything here is
// asked of core.exe; the only thing main decides itself is whether a folder may be deleted. No Electron imports
// (the Recycle Bin and folder creation are passed in), so tests need only fakes.
import { isAbsolute, join, relative, resolve, sep } from 'path'
import type { ModelInfo } from '../../shared/core'
import {
  isHardwareReport,
  parseCatalogView,
  type CatalogView,
  type DownloadItem,
  type HardwareReport
} from '../../shared/setup'

/** The folder models are saved in when the user hasn't chosen one: easy to find in Explorer. */
export function defaultModelsDir(homeDir: string): string {
  return join(homeDir, 'OpenVatra', 'Models')
}

/**
 * Whether `child` is strictly inside `parent` (the folder itself doesn't count). Compared after resolving, so `..`
 * and mixed slashes can't fool it. Windows paths are case-insensitive, hence the lower-casing.
 */
export function isInside(parent: string, child: string): boolean {
  if (!isAbsolute(parent) || !isAbsolute(child)) return false
  const path = relative(resolve(parent).toLowerCase(), resolve(child).toLowerCase())
  return path !== '' && path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path)
}

export interface SetupClientOptions {
  /** The supervisor's `request`: core's address and token stay there. */
  request: (path: string, init?: RequestInit) => Promise<Response>
  /** The folder models live in right now (the chosen one, or the default). */
  modelsDir: () => string
  /** Creates a folder and its parents if missing. */
  makeDir: (path: string) => Promise<void>
  /** Moves a folder to the Recycle Bin (`shell.trashItem`). */
  trash: (path: string) => Promise<void>
  models: () => ModelInfo[]
  unload: (id: string) => Promise<void>
  /** Main's latest copy of core's download queue. */
  downloads: () => DownloadItem[]
  log: { warn: (message: string, error?: unknown) => void }
  /** Pause between checks while waiting for a model to unload; tests pass 1. */
  pollMs?: number
  /** Pause before trying the Recycle Bin again; tests pass 1. */
  retryMs?: number
}

export interface SetupClient {
  hardware: () => Promise<HardwareReport>
  catalog: () => Promise<CatalogView>
  download: (catalogId: string) => Promise<void>
  downloadEngine: () => Promise<void>
  cancel: (id: string) => Promise<void>
  resume: (id: string) => Promise<void>
  remove: (catalogId: string) => Promise<void>
}

const unloadWaitMs = 15_000
const trashAttempts = 3

/** Shown when Windows won't take the folder; Electron's own text ("Operation was aborted") says nothing useful. */
export const trashFailedMessage =
  'Windows could not move the model to the Recycle Bin. A file may still be in use, or the model may be too big ' +
  'for the Recycle Bin. Try again in a moment, or delete its folder in File Explorer.'

export function createSetupClient(options: SetupClientOptions): SetupClient {
  const {
    request,
    modelsDir,
    makeDir,
    trash,
    models,
    unload,
    downloads,
    log,
    pollMs = 250,
    retryMs = 2_000
  } = options

  async function json(path: string, init?: RequestInit): Promise<unknown> {
    const response = await request(path, init)
    if (!response.ok) throw new Error(await errorMessage(response))
    return response.json()
  }

  async function hardware(): Promise<HardwareReport> {
    const body = await json('/api/hardware')
    if (!isHardwareReport(body)) throw new Error('core sent an unreadable hardware report')
    return body
  }

  async function catalog(): Promise<CatalogView> {
    const view = parseCatalogView(await json('/api/catalog'))
    if (!view) throw new Error('core sent an unreadable catalog')
    return view
  }

  async function download(catalogId: string): Promise<void> {
    // Core only writes into the folder; making sure it exists is ours, so the default needs no setup step.
    await makeDir(modelsDir())
    await json('/api/downloads', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ catalogId })
    })
  }

  async function downloadEngine(): Promise<void> {
    // Core picks the folder (engines/<tag>-cuda) and the files from the pin in llama.json; nothing here to choose.
    await json('/api/downloads', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ engine: 'cuda' })
    })
  }

  async function cancel(id: string): Promise<void> {
    await json(`/api/downloads/${encodeURIComponent(id)}`, { method: 'DELETE' })
  }

  async function resume(id: string): Promise<void> {
    await json(`/api/downloads/${encodeURIComponent(id)}/resume`, { method: 'POST' })
  }

  /** The model ids (file names without .gguf) a catalog entry's files appear as in core's model list. */
  async function modelIdsOf(catalogId: string): Promise<string[]> {
    const body = (await json('/api/catalog')) as {
      entries?: { id?: unknown; files?: { name?: unknown }[] }[]
    }
    const entry = body.entries?.find((candidate) => candidate.id === catalogId)
    return (entry?.files ?? []).flatMap((file) =>
      typeof file.name === 'string' ? [file.name.replace(/\.gguf$/i, '')] : []
    )
  }

  async function remove(catalogId: string): Promise<void> {
    // The folder comes from core, but core is another process: it must still lie inside the models folder.
    const body = (await json(`/api/catalog/${encodeURIComponent(catalogId)}/folder`)) as { folder?: unknown }
    const folder = body.folder
    if (typeof folder !== 'string' || !isInside(modelsDir(), folder)) {
      throw new Error('That folder is not inside the models folder, so it was not removed')
    }

    // A loaded model keeps its file open, which would make the Recycle Bin move fail.
    const ids = await modelIdsOf(catalogId)
    const active = (): ModelInfo[] => models().filter((m) => ids.includes(m.id) && m.state !== 'stopped')
    await Promise.all(active().map((m) => unload(m.id)))
    for (let waited = 0; active().length > 0; waited += pollMs) {
      if (waited >= unloadWaitMs) throw new Error('The model did not stop in time, try again')
      await new Promise((done) => setTimeout(done, pollMs))
    }

    await trashWithRetry(catalogId, folder)

    // Core reads the folder only when something it knows about changes; a move to the Recycle Bin isn't one, so it is
    // told, and the model lists drop the model. Tidying up like the dismissal below: a failure is only logged.
    await json('/api/models/refresh', { method: 'POST' }).catch((error) =>
      log.warn('setup: could not ask core to re-read the models folder', error)
    )

    // Core keeps a finished download in its queue; left there, the row would read "Almost ready" for a model that is
    // gone. Dismissing it is tidying up, so a failure is only logged: the removal itself worked.
    if (downloads().some((item) => item.id === catalogId && item.state === 'done')) {
      await cancel(catalogId).catch((error) =>
        log.warn(`setup: could not dismiss the download of ${catalogId}`, error)
      )
    }
  }

  // Windows can hold a file for a moment after its process ends, and Defender scans a fresh download; both make the
  // move fail with "Operation was aborted", so a short wait and another try usually succeeds.
  async function trashWithRetry(catalogId: string, folder: string): Promise<void> {
    for (let attempt = 1; ; attempt++) {
      try {
        await trash(folder)
        return
      } catch (error) {
        log.warn(`setup: Recycle Bin move of ${catalogId} failed (try ${attempt} of ${trashAttempts})`, error)
        if (attempt >= trashAttempts) throw new Error(trashFailedMessage, { cause: error })
        await new Promise((done) => setTimeout(done, retryMs))
      }
    }
  }

  return { hardware, catalog, download, downloadEngine, cancel, resume, remove }
}

/** core's errors are `{ "error": { "code", "message" } }`; anything else gets a generic message. */
async function errorMessage(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: { message?: unknown } }
    const message = body.error?.message
    if (typeof message === 'string' && message) return message.slice(0, 300)
  } catch {
    // not JSON: fall through
  }
  return `core answered with HTTP ${response.status}`
}
