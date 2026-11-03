// Keeps core.exe's config equal to settings.json: settings.json is the one source of truth, and core only ever
// holds a copy that main pushes (POST /api/config). Pure functions plus one small factory, so tests need no Electron.
import type { ModelsSettings, Settings } from '../../shared/settings'

/** The body core expects (core/internal/config). Core uses "" for "not chosen" and 0 minutes for "never". */
export function toCoreConfig(models: ModelsSettings): Record<string, unknown> {
  return {
    llamaServerPath: models.llamaServerPath ?? '',
    modelsDir: models.modelsDir ?? '',
    embeddingModel: models.embeddingModel ?? '',
    idleUnloadMinutes: models.idleUnloadMinutes ?? 0,
    options: models.options
  }
}

export interface ConfigSync {
  /** Sends the current config now. Never rejects: a failure is logged and the next change or start retries. */
  sync: () => Promise<void>
  /** For the settings store's `onChange`: syncs only when `models` actually changed (theme changes don't). */
  onSettingsChange: (settings: Settings, previous: Settings) => void
}

export function createConfigSync(
  getSettings: () => Settings,
  post: (path: string, body: unknown) => Promise<void>,
  log: { warn: (message: string, error?: unknown) => void }
): ConfigSync {
  // Sends run one after another, and each reads the settings when its turn comes. So two quick changes can't
  // arrive out of order and leave core with the older one.
  let queue: Promise<void> = Promise.resolve()

  function sync(): Promise<void> {
    queue = queue.then(async () => {
      try {
        await post('/api/config', toCoreConfig(getSettings().models))
      } catch (error) {
        log.warn('Could not send the config to core', error)
      }
    })
    return queue
  }

  return {
    sync,
    onSettingsChange: (settings, previous) => {
      if (JSON.stringify(settings.models) !== JSON.stringify(previous.models)) void sync()
    }
  }
}
