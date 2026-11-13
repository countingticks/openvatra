// What the UI may know about core.exe (the Go models service). Shared so main, preload and renderer agree.

/** How the window reaches core directly. */
export interface CoreConnection {
  /** "http://127.0.0.1:<port>" */
  baseUrl: string
  /** A ui-scoped token for this core run. Never logged, never put in a URL. */
  token: string
}

export type CoreState =
  | { status: 'starting' }
  | { status: 'ready'; port: number; version: string; connection: CoreConnection }
  | { status: 'problem'; reason: string }

function isCoreConnection(value: unknown): value is CoreConnection {
  if (typeof value !== 'object' || value === null) return false
  const { baseUrl, token } = value as Record<string, unknown>
  return (
    typeof baseUrl === 'string' &&
    /^http:\/\/127\.0\.0\.1:\d{1,5}$/.test(baseUrl) &&
    typeof token === 'string' &&
    /^[0-9a-f]{64}$/.test(token)
  )
}

/** Checks a value that crossed a process boundary; the preload uses it so the UI only ever sees a real state. */
export function isCoreState(value: unknown): value is CoreState {
  if (typeof value !== 'object' || value === null) return false
  const { status, port, version, reason, connection } = value as Record<string, unknown>
  if (status === 'starting') return true
  if (status === 'ready')
    return typeof port === 'number' && typeof version === 'string' && isCoreConnection(connection)
  return status === 'problem' && typeof reason === 'string'
}
