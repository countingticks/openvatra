// Main's copy of core's model settings: the last entry core gave, the writes the window asks for, and the refresh
// when core says the section moved on. One queue runs the reads and writes one after another, so two quick changes
// never PUT with the same rev. No Electron imports, so tests need only a fake `request`.
import { ConfigConflictError, type ConfigClient, type CoreModels, type ModelsEntry } from './configClient'

export interface ModelSettings {
  /** The last entry core gave in this run; null until it answered once. Kept while core restarts. */
  entry(): ModelsEntry | null
  /** GETs into the cache. Rejects with the client's error; the cache is unchanged then. */
  refresh(): Promise<ModelsEntry>
  /** Merges `change` into the cached value and PUTs the whole section with the cached rev. */
  update(change: Partial<CoreModels>): Promise<ModelsEntry>
  /** For `event: config`: refreshes when `models` moved past the cached rev. Never throws. */
  noteChanged(section: string, rev: number): void
  /** Called after the cache changes (rev or value differ); returns unsubscribe. */
  onChange(listener: (entry: ModelsEntry) => void): () => void
}

export interface ModelSettingsOptions {
  client: ConfigClient
  isReady: () => boolean
  log: { warn: (message: string, error?: unknown) => void }
}

/** Keys left undefined mean "no change"; the rest replace (`options` as a whole map, as the UI sends it). */
function merge(value: CoreModels, change: Partial<CoreModels>): CoreModels {
  const defined = Object.fromEntries(Object.entries(change).filter(([, v]) => v !== undefined))
  return { ...value, ...defined }
}

export function createModelSettings({ client, isReady, log }: ModelSettingsOptions): ModelSettings {
  let cached: ModelsEntry | null = null
  let queue: Promise<unknown> = Promise.resolve()
  const listeners = new Set<(entry: ModelsEntry) => void>()

  function enqueue<T>(job: () => Promise<T>): Promise<T> {
    const run = queue.then(job)
    // A failed call must not block the ones after it.
    queue = run.catch(() => undefined)
    return run
  }

  function set(next: ModelsEntry): ModelsEntry {
    const changed = cached === null || JSON.stringify(cached) !== JSON.stringify(next)
    cached = next
    if (changed) for (const listener of listeners) listener(structuredClone(next))
    return structuredClone(next)
  }

  async function read(): Promise<ModelsEntry> {
    return set(await client.getModels())
  }

  function refresh(): Promise<ModelsEntry> {
    return enqueue(read)
  }

  function update(change: Partial<CoreModels>): Promise<ModelsEntry> {
    if (!isReady()) return Promise.reject(new Error('The models service is not running'))
    return enqueue(async () => {
      const base = cached ?? (await read())
      try {
        return set(await client.putModels(base.rev, merge(base.value, change)))
      } catch (error) {
        if (!(error instanceof ConfigConflictError)) throw error
        // Someone else wrote first (core's engine switch, another window): apply the change to theirs, once.
        set(error.current)
        try {
          return set(await client.putModels(error.current.rev, merge(error.current.value, change)))
        } catch (again) {
          if (again instanceof ConfigConflictError) set(again.current)
          throw again
        }
      }
    })
  }

  function noteChanged(section: string, rev: number): void {
    const stale = (): boolean => section === 'models' && (cached === null || rev > cached.rev)
    if (!stale()) return
    // Checked again in the queue: an event for our own write can arrive before the PUT's answer does.
    void enqueue(async () => {
      if (stale()) await read()
    }).catch((error) => log.warn('Could not read the model settings from core', error))
  }

  return {
    entry: () => (cached ? structuredClone(cached) : null),
    refresh,
    update,
    noteChanged,
    onChange: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }
  }
}
