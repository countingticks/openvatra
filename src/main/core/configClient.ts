// core's model settings (GET and PUT /api/config/models). core owns them; main writes only the v6 import and a path
// the user picked in its file dialog. No Electron imports, so tests need only a fake `request`.
import { z } from 'zod'
import { engines, type LegacyModels } from '../../shared/settings'
import { coreErrorMessage } from './coreError'

/** The `models` section as core stores it: the same six keys as a v6 file's `legacyModels`. */
export type CoreModels = LegacyModels

export interface ModelsEntry {
  rev: number // 0 = never written; value is the defaults
  value: CoreModels
  effective: { llamaServerPath: string; modelsDir: string }
}

// core's own rules, not the UI's narrower ones (e.g. any 1–1440 minutes), so a value the UI can't pick never makes
// the whole section unreadable.
const entrySchema = z.object({
  rev: z.number().int().min(0),
  value: z.object({
    llamaServerPath: z.string().nullable(),
    modelsDir: z.string().nullable(),
    embeddingModel: z.string().nullable(),
    idleUnloadMinutes: z.number().int().min(1).max(1440).nullable(),
    options: z.record(z.string(), z.object({ args: z.string().optional() })),
    engine: z.enum(engines)
  }),
  effective: z.object({ llamaServerPath: z.string(), modelsDir: z.string() })
})

/** The PUT carried a rev core no longer has; `current` is core's entry now. */
export class ConfigConflictError extends Error {
  constructor(
    message: string,
    readonly current: ModelsEntry
  ) {
    super(message)
    this.name = 'ConfigConflictError'
  }
}

/** core refused the value; the message is core's sentence naming the field. */
export class ConfigInvalidError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ConfigInvalidError'
  }
}

/** core has no writable database. */
export class ConfigUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ConfigUnavailableError'
  }
}

export interface ConfigClient {
  getModels(): Promise<ModelsEntry>
  putModels(rev: number, value: CoreModels): Promise<ModelsEntry>
  /** GETs the models section, sets key to path, PUTs it with that rev; one more try on a conflict. */
  setModelPath(key: 'llamaServerPath' | 'modelsDir', path: string): Promise<void>
}

const path = '/api/config/models'

function parseEntry(body: unknown): ModelsEntry {
  const result = entrySchema.safeParse(body)
  if (!result.success) throw new Error('core sent a malformed config')
  // The schema allows any minutes core accepts; the IPC type names the UI's choices, so this is a widening on purpose.
  return result.data as ModelsEntry
}

async function answer(response: Response): Promise<ModelsEntry> {
  if (response.ok) return parseEntry(await response.json().catch(() => undefined))
  const body: unknown = await response
    .clone()
    .json()
    .catch(() => undefined)
  const code = (body as { error?: unknown } | undefined)?.error
  const message = await coreErrorMessage(response)
  if (response.status === 409 && code === 'config_conflict') {
    throw new ConfigConflictError(message, parseEntry((body as { current?: unknown }).current))
  }
  if (response.status === 400 && code === 'invalid_config') throw new ConfigInvalidError(message)
  if (response.status === 503 && code === 'config_unavailable') throw new ConfigUnavailableError(message)
  throw new Error(message)
}

export function createConfigClient(
  request: (path: string, init?: RequestInit) => Promise<Response>
): ConfigClient {
  const getModels = async (): Promise<ModelsEntry> => answer(await request(path))
  const putModels = async (rev: number, value: CoreModels): Promise<ModelsEntry> =>
    answer(
      await request(path, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rev, value })
      })
    )
  return {
    getModels,
    putModels,
    setModelPath: async (key, chosen) => {
      const base = await getModels()
      try {
        await putModels(base.rev, { ...base.value, [key]: chosen })
      } catch (error) {
        if (!(error instanceof ConfigConflictError)) throw error
        // Someone else wrote first (core's engine switch): apply the path to theirs, once.
        await putModels(error.current.rev, { ...error.current.value, [key]: chosen })
      }
    }
  }
}
