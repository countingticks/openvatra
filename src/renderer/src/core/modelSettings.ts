// The window's writes to core's two model sections, engine.llamaserver and provider.llamacpp. One at a time per
// store and section, each PUT with the rev it last saw, and the screen changes only when core answers (no optimistic
// update): a failure leaves the cached value as it was.
// ModelsView and ModelsChange keep the shape the screens had before the split; they go once each screen reads the
// section that owns its field.
import { failureReason } from '../lib/modelText'
import type { AppDispatch, RootState } from '../store/store'
import { coreApi } from './coreApi'
import type {
  GetConfigEngineLlamaserverApiResponse,
  GetConfigProviderLlamacppApiResponse,
  LlamaCppSettings,
  LlamaServerSettings,
  ModelOptions
} from './generated'

/** Both model sections as one value, with the names the screens use. */
export interface ModelsView {
  llamaServerPath: string | null
  modelsDir: string | null
  embeddingModel: string | null
  idleUnloadMinutes: number | null
  options: Record<string, ModelOptions>
  engine: 'bundled' | 'cuda'
}

/** core's defaults for engine.llamaserver (llamaserver.DefaultSettings). */
export const defaultEngineSettings: Readonly<LlamaServerSettings> = { build: 'bundled', path: null }

/** core's defaults for provider.llamacpp (llamacpp.DefaultSettings). */
export const defaultLlamacppSettings: Readonly<LlamaCppSettings> = {
  embeddingModel: null,
  idleUnloadMinutes: 15,
  modelsDir: null,
  options: {}
}

/** Both sections' values as the screens see them. */
export function toModelsView(engine: LlamaServerSettings, llamacpp: LlamaCppSettings): ModelsView {
  return {
    embeddingModel: llamacpp.embeddingModel,
    engine: engine.build,
    idleUnloadMinutes: llamacpp.idleUnloadMinutes,
    llamaServerPath: engine.path,
    modelsDir: llamacpp.modelsDir,
    options: llamacpp.options
  }
}

/** core's defaults for both sections, as one value. */
export const defaultCoreModels: Readonly<ModelsView> = toModelsView(
  defaultEngineSettings,
  defaultLlamacppSettings
)

/** What the window may change: the paths only back to null (decision 2); `options` replaces the whole map. */
export type ModelsChange = Partial<
  Pick<ModelsView, 'embeddingModel' | 'idleUnloadMinutes' | 'options' | 'engine'>
> & {
  llamaServerPath?: null
  modelsDir?: null
}

interface Entry<V> {
  rev: number
  value: V
}

/** How one section is read, cached and written; the endpoints differ, the rules don't. */
interface Section<V extends object, E extends Entry<V>> {
  name: string
  cached(getState: () => RootState): E | undefined
  read(dispatch: AppDispatch): Promise<E>
  remember(dispatch: AppDispatch, entry: E): Promise<void>
  put(dispatch: AppDispatch, body: Entry<V>): Promise<E>
}

const engineSection: Section<LlamaServerSettings, GetConfigEngineLlamaserverApiResponse> = {
  name: 'engine.llamaserver',
  cached: (getState) => coreApi.endpoints.getConfigEngineLlamaserver.select()(getState()).data,
  read: (dispatch) =>
    dispatch(coreApi.endpoints.getConfigEngineLlamaserver.initiate(undefined, { subscribe: false })).unwrap(),
  remember: async (dispatch, entry) => {
    await dispatch(coreApi.util.upsertQueryData('getConfigEngineLlamaserver', undefined, entry))
  },
  put: (dispatch, body) =>
    dispatch(coreApi.endpoints.putConfigEngineLlamaserver.initiate({ body }, { track: false })).unwrap()
}

const llamacppSection: Section<LlamaCppSettings, GetConfigProviderLlamacppApiResponse> = {
  name: 'provider.llamacpp',
  cached: (getState) => coreApi.endpoints.getConfigProviderLlamacpp.select()(getState()).data,
  read: (dispatch) =>
    dispatch(coreApi.endpoints.getConfigProviderLlamacpp.initiate(undefined, { subscribe: false })).unwrap(),
  remember: async (dispatch, entry) => {
    await dispatch(coreApi.util.upsertQueryData('getConfigProviderLlamacpp', undefined, entry))
  },
  put: (dispatch, body) =>
    dispatch(coreApi.endpoints.putConfigProviderLlamacpp.initiate({ body }, { track: false })).unwrap()
}

interface Conflict<E> {
  status: 409
  data: { error: 'config_conflict'; current: E }
}

function isConflict<E>(error: unknown): error is Conflict<E> {
  if (typeof error !== 'object' || error === null) return false
  const { status, data } = error as { status?: unknown; data?: { error?: unknown; current?: unknown } }
  return status === 409 && data?.error === 'config_conflict' && typeof data.current === 'object'
}

/** Keys set to undefined are left out; the rest replace what core has. */
function merge<V extends object>(value: V, change: Partial<V>): V {
  const next = { ...value } as Record<string, unknown>
  for (const [key, changed] of Object.entries(change)) {
    if (changed !== undefined) next[key] = changed
  }
  return next as V
}

async function put<V extends object, E extends Entry<V>>(
  section: Section<V, E>,
  dispatch: AppDispatch,
  entry: E,
  change: Partial<V>
): Promise<void> {
  const answer = await section.put(dispatch, { rev: entry.rev, value: merge(entry.value, change) })
  await section.remember(dispatch, answer)
}

async function write<V extends object, E extends Entry<V>>(
  section: Section<V, E>,
  change: Partial<V>,
  dispatch: AppDispatch,
  getState: () => RootState
): Promise<void> {
  const entry = section.cached(getState) ?? (await section.read(dispatch))
  try {
    await put(section, dispatch, entry, change)
  } catch (error) {
    if (!isConflict<E>(error)) throw error
    // Someone else wrote in between: apply this change on top of theirs, once.
    await section.remember(dispatch, error.data.current)
    try {
      await put(section, dispatch, error.data.current, change)
    } catch (again) {
      if (isConflict<E>(again)) await section.remember(dispatch, again.data.current)
      throw again
    }
  }
}

// One promise chain per store and section, so a change is PUT with the rev the previous one got back.
const queues = new WeakMap<AppDispatch, Map<string, Promise<void>>>()

function enqueue<V extends object, E extends Entry<V>>(
  section: Section<V, E>,
  change: Partial<V>,
  dispatch: AppDispatch,
  getState: () => RootState,
  after: Promise<unknown> = Promise.resolve()
): Promise<void> {
  let perSection = queues.get(dispatch)
  if (!perSection) {
    perSection = new Map()
    queues.set(dispatch, perSection)
  }
  const previous = perSection.get(section.name) ?? Promise.resolve()
  const run = Promise.all([previous, after.catch(() => undefined)]).then(() =>
    write(section, change, dispatch, getState)
  )
  // A failed write must not block the next one.
  perSection.set(
    section.name,
    run.catch(() => undefined)
  )
  return run
}

/** The change split by the section that owns each key; a section with no key gets undefined. */
function splitChange(change: ModelsChange): {
  engine?: Partial<LlamaServerSettings>
  llamacpp?: Partial<LlamaCppSettings>
} {
  const engine: Partial<LlamaServerSettings> = {}
  const llamacpp: Partial<LlamaCppSettings> = {}
  if (change.llamaServerPath !== undefined) engine.path = change.llamaServerPath
  if (change.engine !== undefined) engine.build = change.engine
  if (change.modelsDir !== undefined) llamacpp.modelsDir = change.modelsDir
  if (change.embeddingModel !== undefined) llamacpp.embeddingModel = change.embeddingModel
  if (change.idleUnloadMinutes !== undefined) llamacpp.idleUnloadMinutes = change.idleUnloadMinutes
  if (change.options !== undefined) llamacpp.options = change.options
  return {
    engine: Object.keys(engine).length > 0 ? engine : undefined,
    llamacpp: Object.keys(llamacpp).length > 0 ? llamacpp : undefined
  }
}

/**
 * Queues the change on the section(s) that own its keys, the engine section first; resolves when core saved it,
 * rejects with an Error whose message is failureReason's text for the first write that failed.
 */
export function updateModels(
  change: ModelsChange
): (dispatch: AppDispatch, getState: () => RootState) => Promise<void> {
  return async (dispatch, getState) => {
    const split = splitChange(change)
    const runs: Promise<void>[] = []
    if (split.engine) runs.push(enqueue(engineSection, split.engine, dispatch, getState))
    if (split.llamacpp) runs.push(enqueue(llamacppSection, split.llamacpp, dispatch, getState, runs[0]))
    const results = await Promise.allSettled(runs)
    const failed = results.find((result) => result.status === 'rejected')
    if (failed) throw new Error(failureReason(failed.reason))
  }
}
