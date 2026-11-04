// Reads and writes the settings file. Nothing on disk is trusted: every load is parsed, migrated and validated,
// and a bad file is set aside as `.bak` so the app always starts. Uses only Node's fs (no Electron), so tests can
// point it at a temporary folder.
import { randomUUID } from 'crypto'
import { open, readFile, rename, rm } from 'fs/promises'
import { joinArgs, splitArgs } from '../shared/args'
import { defaultSettings, type Settings, settingsSchema, settingsSchemaVersion } from '../shared/settings'

type Migration = (old: Record<string, unknown>) => Record<string, unknown>

/** `migrations[n]` turns a version-n file into a version-(n + 1) file; `migrate` sets the new version number. */
const migrations: Readonly<Record<number, Migration>> = {
  // 1 → 2: Settings became a dialog, so a file left on the Settings tab reopens on Chat instead of failing
  // validation (which would set the whole file aside and lose every other setting).
  1: (old) => (old['lastTab'] === 'settings' ? { ...old, lastTab: 'chat' } : old),
  // 2 → 3: `models` is new. Nothing to move; the schema fills in its defaults. Listed anyway so the chain has no
  // gap, and so a future change to the defaults has an obvious place to go.
  2: (old) => old,
  // 3 → 4: the number fields and the argument list became one line of argument text per model.
  3: (old) => {
    const models = old['models']
    if (!isRecord(models) || !isRecord(models['options'])) return old
    const options = Object.fromEntries(
      Object.entries(models['options']).map(([id, value]) => [
        id,
        isRecord(value) ? argsFromV3(value) : value
      ])
    )
    return { ...old, models: { ...models, options } }
  },
  // 4 → 5: no arguments for every model, no per-model unload time or projector switch. An options entry left
  // without `args` is removed, so the file doesn't keep empty objects.
  4: (old) => {
    const models = old['models']
    if (!isRecord(models)) return old
    const rest = { ...models }
    delete rest['sharedArgs']
    const options = isRecord(rest['options'])
      ? Object.fromEntries(
          Object.entries(rest['options']).flatMap(([id, value]) => {
            if (!isRecord(value) || typeof value['args'] !== 'string' || value['args'] === '') return []
            return [[id, { args: value['args'] }]]
          })
        )
      : undefined
    return { ...old, models: { ...rest, ...(options && { options }) } }
  },
  // 5 → 6: `engine`, `showAdvanced` and `cudaOfferDismissed` are new; the schema fills in their defaults.
  5: (old) => old
}

/** `{ contextSize, gpuLayers, extraArgs }` → `{ args: '-c … -ngl … …' }`; `{}` if nothing was set. */
function argsFromV3(options: Record<string, unknown>): Record<string, unknown> {
  const { contextSize, gpuLayers, extraArgs } = options
  const args: string[] = []
  if (typeof contextSize === 'number') args.push('-c', String(contextSize))
  if (typeof gpuLayers === 'number') args.push('-ngl', String(gpuLayers))
  if (Array.isArray(extraArgs)) args.push(...extraArgs.filter((arg) => typeof arg === 'string'))
  const text = joinArgs(args)
  // v3 never checked for flags core sets itself; drop such a model's arguments rather than set the whole file aside.
  return text && splitArgs(text).ok ? { args: text } : {}
}

/** What happened while loading, so the caller can log it. */
export type LoadOutcome =
  | { kind: 'loaded'; droppedSharedArgs?: true }
  | { kind: 'missing' }
  | { kind: 'recovered'; reason: 'corrupt' | 'invalid'; backupPath: string }
  | { kind: 'unreadable'; error: unknown }

export interface LoadResult {
  settings: Settings
  outcome: LoadOutcome
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** A v4 file whose shared arguments v5 throws away; worth one log line, because the user typed them. */
function hadSharedArgs(raw: unknown): boolean {
  if (!isRecord(raw) || raw['schemaVersion'] !== 4 || !isRecord(raw['models'])) return false
  const text = raw['models']['sharedArgs']
  return typeof text === 'string' && text.trim() !== ''
}

/** Upgrades an older file step by step. Anything it doesn't recognise is returned unchanged for zod to reject. */
export function migrate(raw: unknown, steps: Readonly<Record<number, Migration>> = migrations): unknown {
  if (!isRecord(raw)) return raw
  let data = raw
  let version = data['schemaVersion']
  while (typeof version === 'number' && version < settingsSchemaVersion && steps[version]) {
    data = { ...steps[version](data), schemaVersion: version + 1 }
    version = data['schemaVersion']
  }
  return data
}

function defaults(): Settings {
  return structuredClone(defaultSettings)
}

export async function loadSettings(filePath: string): Promise<LoadResult> {
  let text: string
  try {
    text = await readFile(filePath, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { settings: defaults(), outcome: { kind: 'missing' } }
    }
    // Locked or no permission: leave the file alone, it may be fine next time.
    return { settings: defaults(), outcome: { kind: 'unreadable', error } }
  }

  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return setAside(filePath, 'corrupt')
  }

  const parsed = settingsSchema.safeParse(migrate(raw))
  if (!parsed.success) return setAside(filePath, 'invalid')
  return {
    settings: parsed.data,
    outcome: { kind: 'loaded', ...(hadSharedArgs(raw) && { droppedSharedArgs: true }) }
  }
}

/** Keeps the bad file as `.bak` (replacing an older backup) so the user's data is never silently lost. */
async function setAside(filePath: string, reason: 'corrupt' | 'invalid'): Promise<LoadResult> {
  const backupPath = `${filePath}.bak`
  await rename(filePath, backupPath)
  return { settings: defaults(), outcome: { kind: 'recovered', reason, backupPath } }
}

/** The logger methods used here. A parameter, not an import, so tests can pass a fake. */
export interface Logger {
  info(...params: unknown[]): void
  warn(...params: unknown[]): void
  error(...params: unknown[]): void
}

export function logLoadOutcome(logger: Logger, filePath: string, outcome: LoadOutcome): void {
  switch (outcome.kind) {
    case 'loaded':
      logger.info(`Settings loaded from ${filePath}`)
      if (outcome.droppedSharedArgs)
        logger.info('Dropped the arguments for every model (removed in settings v5)')
      break
    case 'missing':
      logger.info(`No settings file at ${filePath} yet; using defaults`)
      break
    case 'recovered':
      logger.warn(`Settings file was ${outcome.reason}; kept it as ${outcome.backupPath} and using defaults`)
      break
    case 'unreadable':
      logger.error(`Could not read settings at ${filePath}; using defaults`, outcome.error)
      break
  }
}

/**
 * Validates, then writes atomically: the full file goes to a temporary file, is flushed to disk, and is renamed
 * over the old one. A rename either happens completely or not at all, so a crash never leaves half a file.
 */
export async function saveSettings(filePath: string, settings: Settings): Promise<void> {
  const valid = settingsSchema.parse(settings)
  // A unique name, so two saves running at once never write into the same temporary file.
  const tempPath = `${filePath}.${randomUUID()}.tmp`
  try {
    const file = await open(tempPath, 'w')
    try {
      await file.writeFile(`${JSON.stringify(valid, null, 2)}\n`, 'utf8')
      await file.sync()
    } finally {
      await file.close()
    }
    await rename(tempPath, filePath)
  } catch (error) {
    await rm(tempPath, { force: true })
    throw error
  }
}
