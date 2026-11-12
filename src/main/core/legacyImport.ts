// The one-time move of a v6 user's model settings (settings.json `legacyModels`) into core. core is the owner from
// then on, so whatever it already has wins; the old copy is dropped once core has given a final answer, and kept
// only when core could not be asked (no database, not running), to try again on the next start.
import { ConfigConflictError, ConfigInvalidError, type ConfigClient, type CoreModels } from './configClient'

/** `retry-later` keeps `legacyModels` for the next ready; every other outcome means drop it. */
export type ImportOutcome = 'imported' | 'core-had-config' | 'conflict' | 'gave-up' | 'retry-later'

export interface ImportLog {
  info(message: string): void
  warn(message: string, error?: unknown): void
  error(message: string, error?: unknown): void
}

const coreWon = 'Model settings: core already has them; dropped the old copy in settings.json'

/**
 * Puts back the one field core's message names (its first word), so the rest can still be imported. A v6 file was
 * checked by the same rules, so this should not happen; it guards against a hand-edited file.
 */
function resetNamedField(value: CoreModels, message: string): CoreModels {
  const field = message.split(/\s/, 1)[0]
  switch (field) {
    case 'llamaServerPath':
    case 'modelsDir':
    case 'embeddingModel':
      return { ...value, [field]: null }
    case 'idleUnloadMinutes':
      return { ...value, idleUnloadMinutes: 15 }
    case 'engine':
      return { ...value, engine: 'bundled' }
    case 'options': {
      const id = /^options for ("(?:[^"\\]|\\.)*")/.exec(message)?.[1]
      if (id === undefined) return { ...value, options: {} }
      try {
        const options = { ...value.options }
        delete options[JSON.parse(id) as string]
        return { ...value, options }
      } catch {
        return { ...value, options: {} }
      }
    }
    default:
      return value
  }
}

export async function importLegacyModels(
  client: ConfigClient,
  legacy: CoreModels,
  log: ImportLog
): Promise<ImportOutcome> {
  try {
    const current = await client.getModels()
    if (current.rev > 0) {
      log.info(coreWon)
      return 'core-had-config'
    }
    await client.putModels(0, legacy)
    log.info('Model settings imported into core')
    return 'imported'
  } catch (error) {
    if (error instanceof ConfigConflictError) {
      log.info(coreWon)
      return 'conflict'
    }
    if (!(error instanceof ConfigInvalidError)) {
      log.warn('Model settings import postponed', error)
      return 'retry-later'
    }
    log.warn(`Model settings import: core refused a value (${error.message})`)
    try {
      await client.putModels(0, resetNamedField(legacy, error.message))
      log.info('Model settings imported into core')
      return 'imported'
    } catch (retryError) {
      log.error("Model settings could not be imported; using core's defaults", retryError)
      return 'gave-up'
    }
  }
}
