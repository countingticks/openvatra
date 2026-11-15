// The one-time move of a v6 user's model settings (settings.json `legacyModels`) into core's two model sections.
// core is the owner from then on, so whatever it already has wins, per section; the old copy is dropped once core has
// given a final answer for both, and kept only when core could not be asked (no database, not running), to try again
// on the next start.
import { upgradeArgs } from '../../shared/args'
import type { LegacyModels } from '../../shared/settings'
import {
  ConfigConflictError,
  ConfigInvalidError,
  type ConfigClient,
  type EngineSection,
  type LlamacppSection,
  type ModelOptions
} from './configClient'

/** `retry-later` keeps `legacyModels` for the next ready; every other outcome means drop it. */
export type ImportOutcome = 'imported' | 'core-had-config' | 'conflict' | 'gave-up' | 'retry-later'

export interface ImportLog {
  info(message: string): void
  warn(message: string, error?: unknown): void
  error(message: string, error?: unknown): void
}

const coreWon = 'Model settings: core already has them; dropped the old copy in settings.json'

/**
 * A v6 value as the two sections core keeps: `llamaServerPath` → `path`, `engine` → `build`, and each model's size and
 * placement flags (core's own now) moved out of its arguments into its fields (upgradeArgs).
 */
export function splitLegacy(
  legacy: LegacyModels,
  log: Pick<ImportLog, 'warn'>
): { engine: EngineSection; llamacpp: LlamacppSection } {
  const options: Record<string, ModelOptions> = {}
  for (const [id, { args }] of Object.entries(legacy.options)) {
    const up = upgradeArgs(args ?? '')
    for (const flag of up.dropped)
      log.warn(`Model settings import: dropped ${flag} from the arguments of ${id}`)
    options[id] = {
      ...(up.args && { args: up.args }),
      ...(up.context !== undefined && { context: up.context }),
      ...(up.placement !== undefined && { placement: up.placement })
    }
  }
  return {
    engine: { path: legacy.llamaServerPath, build: legacy.engine },
    llamacpp: {
      modelsDir: legacy.modelsDir,
      embeddingModel: legacy.embeddingModel,
      idleUnloadMinutes: legacy.idleUnloadMinutes,
      options
    }
  }
}

/** core's message names the field as its first word. */
const namedField = (message: string): string => message.split(/\s/, 1)[0] ?? ''

/**
 * Puts back the one field core's message names, so the rest can still be imported. A v6 file was checked by the same
 * rules, so this should not happen; it guards against a hand-edited file.
 */
function resetEngineField(value: EngineSection, message: string): EngineSection {
  switch (namedField(message)) {
    case 'path':
      return { ...value, path: null }
    case 'build':
      return { ...value, build: 'bundled' }
    default:
      return value
  }
}

function resetLlamacppField(value: LlamacppSection, message: string): LlamacppSection {
  const field = namedField(message)
  switch (field) {
    case 'modelsDir':
    case 'embeddingModel':
      return { ...value, [field]: null }
    case 'idleUnloadMinutes':
      return { ...value, idleUnloadMinutes: 15 }
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

type SectionOutcome =
  { kind: 'imported' | 'core-had-config' | 'conflict' } | { kind: 'gave-up' | 'retry-later'; error: unknown }

/** One section: skipped when core has it, else PUT at rev 0, with one more try after resetting a refused field. */
async function importSection<V>(
  get: () => Promise<{ rev: number }>,
  put: (rev: number, value: V) => Promise<unknown>,
  value: V,
  reset: (value: V, message: string) => V,
  log: ImportLog
): Promise<SectionOutcome> {
  try {
    if ((await get()).rev > 0) return { kind: 'core-had-config' }
    await put(0, value)
    return { kind: 'imported' }
  } catch (error) {
    if (error instanceof ConfigConflictError) return { kind: 'conflict' }
    if (!(error instanceof ConfigInvalidError)) return { kind: 'retry-later', error }
    log.warn(`Model settings import: core refused a value (${error.message})`)
    try {
      await put(0, reset(value, error.message))
      return { kind: 'imported' }
    } catch (retryError) {
      return { kind: 'gave-up', error: retryError }
    }
  }
}

export async function importLegacyModels(
  client: ConfigClient,
  legacy: LegacyModels,
  log: ImportLog
): Promise<ImportOutcome> {
  const { engine, llamacpp } = splitLegacy(legacy, log)
  const results = [
    await importSection(
      () => client.getEngine(),
      (rev, value: EngineSection) => client.putEngine(rev, value),
      engine,
      resetEngineField,
      log
    ),
    await importSection(
      () => client.getLlamacpp(),
      (rev, value: LlamacppSection) => client.putLlamacpp(rev, value),
      llamacpp,
      resetLlamacppField,
      log
    )
  ]
  const find = (kind: SectionOutcome['kind']): SectionOutcome | undefined =>
    results.find((result) => result.kind === kind)

  if (find('imported')) log.info('Model settings imported into core')
  const gaveUp = find('gave-up')
  if (gaveUp && 'error' in gaveUp) {
    log.error("Model settings could not be imported; using core's defaults", gaveUp.error)
  }
  const retry = find('retry-later')
  if (retry && 'error' in retry) {
    log.warn('Model settings import postponed', retry.error)
    return 'retry-later'
  }
  if (find('imported')) return 'imported'
  if (gaveUp) return 'gave-up'
  log.info(coreWon)
  return find('core-had-config') ? 'core-had-config' : 'conflict'
}
