// What the UI may know about core.exe (the Go models service). Shared so main, preload and renderer agree.

export type CoreState =
  | { status: 'starting' }
  | { status: 'ready'; port: number; version: string }
  | { status: 'problem'; reason: string }

/** Checks a value that crossed a process boundary; the preload uses it so the UI only ever sees a real state. */
export function isCoreState(value: unknown): value is CoreState {
  if (typeof value !== 'object' || value === null) return false
  const { status, port, version, reason } = value as Record<string, unknown>
  if (status === 'starting') return true
  if (status === 'ready') return typeof port === 'number' && typeof version === 'string'
  return status === 'problem' && typeof reason === 'string'
}

export const modelStates = ['stopped', 'loading', 'ready', 'error'] as const

export const modelKinds = ['chat', 'embedding', 'unreadable'] as const

/** One model on disk, as core reports it (GET /api/state). */
export interface ModelInfo {
  /** The file name without .gguf. */
  id: string
  state: (typeof modelStates)[number]
  /** Answering a request right now. */
  busy: boolean
  /** Why the last load failed (state 'error'), or why the file can't be read (kind 'unreadable'). */
  error?: string
  sizeBytes: number
  /** File name of the detected vision projector; missing when the model has none. */
  projector?: string
  /** What the file is for, read from its GGUF header. */
  kind: (typeof modelKinds)[number]
}

function isModelInfo(value: unknown): value is ModelInfo {
  if (typeof value !== 'object' || value === null) return false
  const { id, state, busy, error, sizeBytes, projector, kind } = value as Record<string, unknown>
  return (
    typeof id === 'string' &&
    modelStates.includes(state as ModelInfo['state']) &&
    typeof busy === 'boolean' &&
    (error === undefined || typeof error === 'string') &&
    typeof sizeBytes === 'number' &&
    (projector === undefined || typeof projector === 'string') &&
    modelKinds.includes(kind as ModelInfo['kind'])
  )
}

/** Checks a model list that crossed a process boundary (core → main → UI). */
export function isModelList(value: unknown): value is ModelInfo[] {
  return Array.isArray(value) && value.every(isModelInfo)
}
