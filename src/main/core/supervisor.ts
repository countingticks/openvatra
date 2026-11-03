// Starts core.exe (the Go models service) and tracks whether it is usable. Restarting and stopping come later.
import { randomBytes } from 'crypto'
import { spawn as nodeSpawn, type ChildProcessWithoutNullStreams } from 'child_process'
import { createInterface } from 'readline'

export type CoreState =
  | { status: 'starting' }
  | { status: 'ready'; port: number; version: string }
  | { status: 'problem'; reason: string }

/** Must match core/main.go: the per-launch token travels in the environment, never on the command line. */
const tokenEnv = 'OPENVATRA_CORE_TOKEN'

export interface SupervisorOptions {
  exePath: string
  onState: (state: CoreState) => void
  log: { info: (message: string) => void; warn: (message: string) => void }
  // Injected so tests can use a fake child process and a fake network.
  spawn?: (exePath: string, env: NodeJS.ProcessEnv) => ChildProcessWithoutNullStreams
  fetch?: typeof fetch
  /** How long core may take to print its ready line. */
  readyTimeoutMs?: number
}

export interface Supervisor {
  start: () => void
  state: () => CoreState
}

const defaultSpawn: NonNullable<SupervisorOptions['spawn']> = (exePath, env) =>
  nodeSpawn(exePath, ['--port', '0'], { env, windowsHide: true })

export function createSupervisor(options: SupervisorOptions): Supervisor {
  const { exePath, onState, log } = options
  const spawn = options.spawn ?? defaultSpawn
  const doFetch = options.fetch ?? fetch
  const readyTimeoutMs = options.readyTimeoutMs ?? 15_000

  let current: CoreState = { status: 'starting' }
  // After a final state (ready or problem) late events from the same child must not overwrite it.
  let settled = false

  function set(next: CoreState): void {
    current = next
    settled = next.status !== 'starting'
    if (next.status === 'problem') log.warn(`core: ${next.reason}`)
    else log.info(`core: ${next.status}`)
    onState(next)
  }

  function start(): void {
    set({ status: 'starting' })

    const token = randomBytes(32).toString('hex')
    let child: ChildProcessWithoutNullStreams
    try {
      child = spawn(exePath, { ...process.env, [tokenEnv]: token })
    } catch (error) {
      set({ status: 'problem', reason: `core could not be started: ${String(error)}` })
      return
    }

    const timer = setTimeout(() => {
      if (settled) return
      set({ status: 'problem', reason: `core did not report ready within ${readyTimeoutMs / 1000} s` })
      child.kill()
    }, readyTimeoutMs)

    child.on('error', (error) => {
      clearTimeout(timer)
      if (!settled) set({ status: 'problem', reason: `core could not be started: ${error.message}` })
    })
    child.on('exit', (code) => {
      clearTimeout(timer)
      if (!settled) set({ status: 'problem', reason: `core exited (code ${code}) before it was ready` })
    })
    // stderr is unused for now, but an unread pipe can fill up and block the child.
    child.stderr.resume()

    // stdout is a stream of chunks, not lines; readline cuts it into lines for us.
    createInterface({ input: child.stdout }).on('line', (line) => {
      if (settled) return
      const ready = parseReadyLine(line)
      if (!ready) return
      clearTimeout(timer)
      void confirmHealthy(ready.port, ready.version, token)
    })
  }

  async function confirmHealthy(port: number, version: string, token: string): Promise<void> {
    try {
      const response = await doFetch(`http://127.0.0.1:${port}/health`, {
        headers: { Authorization: `Bearer ${token}` }
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      if (!settled) set({ status: 'ready', port, version })
    } catch (error) {
      if (!settled) set({ status: 'problem', reason: `core did not answer /health: ${String(error)}` })
    }
  }

  return { start, state: () => current }
}

function parseReadyLine(line: string): { port: number; version: string } | null {
  try {
    const data: unknown = JSON.parse(line)
    if (typeof data !== 'object' || data === null) return null
    const { event, port, version } = data as Record<string, unknown>
    if (event !== 'ready' || typeof port !== 'number' || typeof version !== 'string') return null
    return { port, version }
  } catch {
    return null // not JSON: some other output line
  }
}
