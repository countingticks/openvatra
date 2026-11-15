// core's model settings: GET and PUT /api/config/engine.llamaserver and /api/config/provider.llamacpp. core owns
// them; main writes only the v6 import and a path the user picked in its file dialog. No Electron imports, so tests
// need only a fake `request`.
import { z } from 'zod'
import type { PickTarget } from '../../shared/ipc'
import { engines } from '../../shared/settings'
import { coreErrorMessage } from './coreError'

type Engine = (typeof engines)[number]

/** The engine.llamaserver section: which llama-server core starts. */
export interface EngineSection {
  path: string | null
  build: Engine
}

/** The provider.llamacpp section: where the models are and how they run. */
export interface LlamacppSection {
  modelsDir: string | null
  embeddingModel: string | null
  idleUnloadMinutes: number | null
  options: Record<string, { args?: string }>
}

export interface SectionEntry<V, E> {
  rev: number // 0 = never written; value is the defaults
  value: V
  effective: E
}

export type EngineEntry = SectionEntry<EngineSection, { path: string }>
export type LlamacppEntry = SectionEntry<LlamacppSection, { modelsDir: string }>

// core's own rules, not the UI's narrower ones (e.g. any 1–1440 minutes), so a value the UI can't pick never makes
// the whole section unreadable.
const engineSchema = z.object({
  rev: z.number().int().min(0),
  value: z.object({ path: z.string().nullable(), build: z.enum(engines) }),
  effective: z.object({ path: z.string() })
})

const llamacppSchema = z.object({
  rev: z.number().int().min(0),
  value: z.object({
    modelsDir: z.string().nullable(),
    embeddingModel: z.string().nullable(),
    idleUnloadMinutes: z.number().int().min(1).max(1440).nullable(),
    options: z.record(z.string(), z.object({ args: z.string().optional() }))
  }),
  effective: z.object({ modelsDir: z.string() })
})

/** The PUT carried a rev core no longer has; `current` is core's entry of that section now. */
export class ConfigConflictError<E> extends Error {
  constructor(
    message: string,
    readonly current: E
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
  getEngine(): Promise<EngineEntry>
  putEngine(rev: number, value: EngineSection): Promise<EngineEntry>
  getLlamacpp(): Promise<LlamacppEntry>
  putLlamacpp(rev: number, value: LlamacppSection): Promise<LlamacppEntry>
  /** GETs the section that owns the path, sets it, PUTs it with that rev; one more try on a conflict. */
  setModelPath(target: PickTarget, path: string): Promise<void>
}

function parser<E>(schema: z.ZodType<E>): (body: unknown) => E {
  return (body) => {
    const result = schema.safeParse(body)
    if (!result.success) throw new Error('core sent a malformed config')
    return result.data
  }
}

async function answer<E>(response: Response, parse: (body: unknown) => E): Promise<E> {
  if (response.ok) return parse(await response.json().catch(() => undefined))
  const body: unknown = await response
    .clone()
    .json()
    .catch(() => undefined)
  const code = (body as { error?: unknown } | undefined)?.error
  const message = await coreErrorMessage(response)
  if (response.status === 409 && code === 'config_conflict') {
    throw new ConfigConflictError(message, parse((body as { current?: unknown }).current))
  }
  if (response.status === 400 && code === 'invalid_config') throw new ConfigInvalidError(message)
  if (response.status === 503 && code === 'config_unavailable') throw new ConfigUnavailableError(message)
  throw new Error(message)
}

type Request = (path: string, init?: RequestInit) => Promise<Response>

interface Section<V, E extends SectionEntry<V, unknown>> {
  get(): Promise<E>
  put(rev: number, value: V): Promise<E>
}

function section<V, E extends SectionEntry<V, unknown>>(
  request: Request,
  path: string,
  parse: (body: unknown) => E
): Section<V, E> {
  return {
    get: async () => answer(await request(path), parse),
    put: async (rev, value) =>
      answer(
        await request(path, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ rev, value })
        }),
        parse
      )
  }
}

/** Sets one field of a section; on a conflict (core's engine switch wrote first) applies it to theirs, once. */
async function setField<V, E extends SectionEntry<V, unknown>>(
  s: Section<V, E>,
  change: Partial<V>
): Promise<void> {
  const base = await s.get()
  try {
    await s.put(base.rev, { ...base.value, ...change })
  } catch (error) {
    if (!(error instanceof ConfigConflictError)) throw error
    const current = error.current as E
    await s.put(current.rev, { ...current.value, ...change })
  }
}

export function createConfigClient(request: Request): ConfigClient {
  // The schemas allow any minutes core accepts; the types name the UI's choices, so this is a widening on purpose.
  const engine = section<EngineSection, EngineEntry>(
    request,
    '/api/config/engine.llamaserver',
    parser(engineSchema)
  )
  const llamacpp = section<LlamacppSection, LlamacppEntry>(
    request,
    '/api/config/provider.llamacpp',
    parser(llamacppSchema)
  )
  return {
    getEngine: engine.get,
    putEngine: engine.put,
    getLlamacpp: llamacpp.get,
    putLlamacpp: llamacpp.put,
    setModelPath: (target, chosen) =>
      target === 'llamaServer'
        ? setField(engine, { path: chosen })
        : setField(llamacpp, { modelsDir: chosen })
  }
}
