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
