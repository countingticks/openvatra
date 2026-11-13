// The window's writes to core's models section. One at a time per store, each PUT with the rev it last saw, and
// the screen changes only when core answers (no optimistic update): a failure leaves the cached value as it was.
import { failureReason } from '../lib/modelText'
import type { AppDispatch, RootState } from '../store/store'
import { coreApi } from './coreApi'
import type { GetConfigModelsApiResponse, Models } from './generated'

/** core's defaults for the models section (config.DefaultModels). */
export const defaultCoreModels: Readonly<Models> = {
  embeddingModel: null,
  engine: 'bundled',
  idleUnloadMinutes: 15,
  llamaServerPath: null,
  modelsDir: null,
  options: {}
}

/** What the window may change: the paths only back to null (decision 2); `options` replaces the whole map. */
export type ModelsChange = Partial<
  Pick<Models, 'embeddingModel' | 'idleUnloadMinutes' | 'options' | 'engine'>
> & {
  llamaServerPath?: null
  modelsDir?: null
}

type Entry = GetConfigModelsApiResponse

interface Conflict {
  status: 409
  data: { error: 'config_conflict'; current: Entry }
}

function isConflict(error: unknown): error is Conflict {
  if (typeof error !== 'object' || error === null) return false
  const { status, data } = error as { status?: unknown; data?: { error?: unknown; current?: unknown } }
  return status === 409 && data?.error === 'config_conflict' && typeof data.current === 'object'
}

/** Keys set to undefined are left out; the rest replace what core has. */
function merge(value: Models, change: ModelsChange): Models {
  const next: Record<string, unknown> = { ...value }
  for (const [key, changed] of Object.entries(change)) {
    if (changed !== undefined) next[key] = changed
  }
  return next as Models
}

// One promise chain per store, so a change is PUT with the rev the previous one got back.
const queues = new WeakMap<AppDispatch, Promise<void>>()

async function cachedOrRead(dispatch: AppDispatch, getState: () => RootState): Promise<Entry> {
  const cached = coreApi.endpoints.getConfigModels.select()(getState()).data
  if (cached) return cached
  return dispatch(coreApi.endpoints.getConfigModels.initiate(undefined, { subscribe: false })).unwrap()
}

async function remember(dispatch: AppDispatch, entry: Entry): Promise<void> {
  await dispatch(coreApi.util.upsertQueryData('getConfigModels', undefined, entry))
}

async function put(dispatch: AppDispatch, entry: Entry, change: ModelsChange): Promise<void> {
  const body = { rev: entry.rev, value: merge(entry.value, change) }
  const answer = await dispatch(
    coreApi.endpoints.putConfigModels.initiate({ body }, { track: false })
  ).unwrap()
  await remember(dispatch, answer)
}

async function write(change: ModelsChange, dispatch: AppDispatch, getState: () => RootState): Promise<void> {
  const entry = await cachedOrRead(dispatch, getState)
  try {
    await put(dispatch, entry, change)
  } catch (error) {
    if (!isConflict(error)) throw error
    // Someone else wrote in between: apply this change on top of theirs, once.
    await remember(dispatch, error.data.current)
    try {
      await put(dispatch, error.data.current, change)
    } catch (again) {
      if (isConflict(again)) await remember(dispatch, again.data.current)
      throw again
    }
  }
}

/** Queues one write; resolves when core saved it, rejects with an Error whose message is failureReason's text. */
export function updateModels(
  change: ModelsChange
): (dispatch: AppDispatch, getState: () => RootState) => Promise<void> {
  return (dispatch, getState) => {
    const previous = queues.get(dispatch) ?? Promise.resolve()
    const run = previous
      .then(() => write(change, dispatch, getState))
      .catch((error: unknown) => {
        throw new Error(failureReason(error))
      })
    // A failed write must not block the next one.
    queues.set(
      dispatch,
      run.catch(() => undefined)
    )
    return run
  }
}
