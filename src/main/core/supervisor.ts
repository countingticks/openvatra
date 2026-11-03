// Runs core.exe (the Go models service): starts it, tracks whether it is usable, restarts it after a crash
// (with back-off, and gives up if it keeps crashing) and shuts it down when the app quits.
import { randomBytes } from 'crypto'
import { spawn as nodeSpawn, type ChildProcessWithoutNullStreams } from 'child_process'
import { createInterface } from 'readline'

import type { CoreState } from '../../shared/core'

export type { CoreState }

/** Must match core/main.go: the per-launch token travels in the environment, never on the command line. */
const tokenEnv = 'OPENVATRA_CORE_TOKEN'

/** Wait before restart number 1, 2, ... after a crash. */
const restartDelaysMs = [1_000, 5_000]
/** Three crashes inside this window mean something is really wrong: restarting forever would only burn CPU. */
const crashWindowMs = 120_000
const maxCrashes = 3

export interface SupervisorOptions {
  exePath: string
  onState: (state: CoreState) => void
  log: { info: (message: string) => void; warn: (message: string) => void }
  // Injected so tests can use a fake child process and a fake network.
  spawn?: (exePath: string, env: NodeJS.ProcessEnv) => ChildProcessWithoutNullStreams
  fetch?: typeof fetch
  /** How long core may take to print its ready line. */
  readyTimeoutMs?: number
  /** How long core gets to exit after POST /shutdown before it is killed. */
  stopTimeoutMs?: number
}

export interface Supervisor {
  start: () => void
  /** Asks core to shut down, kills it after the timeout. Resolves once it is gone; no restarts afterwards. */
  stop: () => Promise<void>
  state: () => CoreState
  /** Stops the running core (if any) and starts a fresh one, forgetting earlier crashes. No-op once stop() ran. */
  restart: () => Promise<void>
}

// One launch of core.exe. Events from an old child must never touch the state of a newer one.
interface Attempt {
  child: ChildProcessWithoutNullStreams
  token: string
  port?: number
  failed: boolean
  exited: boolean
  onExit?: () => void
}

const defaultSpawn: NonNullable<SupervisorOptions['spawn']> = (exePath, env) =>
  nodeSpawn(exePath, ['--port', '0'], { env, windowsHide: true })

export function createSupervisor(options: SupervisorOptions): Supervisor {
  const { exePath, onState, log } = options
  const spawn = options.spawn ?? defaultSpawn
  const doFetch = options.fetch ?? fetch
  const readyTimeoutMs = options.readyTimeoutMs ?? 15_000
  const stopTimeoutMs = options.stopTimeoutMs ?? 8_000

  let current: CoreState = { status: 'starting' }
  let active: Attempt | null = null
  let stopping = false
  let restartTimer: ReturnType<typeof setTimeout> | undefined
  let crashTimes: number[] = []

  function set(next: CoreState): void {
    current = next
    if (next.status === 'problem') log.warn(`core: ${next.reason}`)
    else log.info(`core: ${next.status}`)
    onState(next)
  }

  // Every way an attempt can go wrong ends here, once per attempt. Decides: restart soon, or give up.
  function fail(attempt: Attempt, reason: string): void {
    if (attempt.failed || stopping) return
    attempt.failed = true

    const now = Date.now()
    crashTimes = [...crashTimes.filter((time) => now - time < crashWindowMs), now]
    if (crashTimes.length >= maxCrashes) {
      set({
        status: 'problem',
        reason: `${reason}; giving up after ${maxCrashes} crashes in ${crashWindowMs / 60_000} minutes`
      })
      return
    }
    const delay = restartDelaysMs[crashTimes.length - 1]
    set({ status: 'problem', reason })
    log.info(`core: restarting in ${delay / 1000} s`)
    restartTimer = setTimeout(start, delay)
  }

  function start(): void {
    if (stopping) return
    set({ status: 'starting' })

    const token = randomBytes(32).toString('hex')
    let child: ChildProcessWithoutNullStreams
    try {
      child = spawn(exePath, { ...process.env, [tokenEnv]: token })
    } catch (error) {
      // Not worth retrying: the exe is missing or not runnable, and that does not fix itself.
      set({ status: 'problem', reason: `core could not be started: ${String(error)}` })
      return
    }
    const attempt: Attempt = { child, token, failed: false, exited: false }
    active = attempt
    let ready = false

    const timer = setTimeout(() => {
      if (attempt.failed || ready) return
      fail(attempt, `core did not report ready within ${readyTimeoutMs / 1000} s`)
      child.kill()
    }, readyTimeoutMs)

    child.on('error', (error) => {
      clearTimeout(timer)
      if (!ready) fail(attempt, `core could not be started: ${error.message}`)
    })
    child.on('exit', (code) => {
      clearTimeout(timer)
      attempt.exited = true
      attempt.onExit?.()
      fail(
        attempt,
        ready ? `core exited unexpectedly (code ${code})` : `core exited (code ${code}) before it was ready`
      )
    })
    // stderr is unused for now, but an unread pipe can fill up and block the child.
    child.stderr.resume()

    // stdout is a stream of chunks, not lines; readline cuts it into lines for us.
    createInterface({ input: child.stdout }).on('line', (line) => {
      if (ready || attempt.failed) return
      const parsed = parseReadyLine(line)
      if (!parsed) return
      ready = true
      clearTimeout(timer)
      void confirmHealthy(attempt, parsed.port, parsed.version)
    })
  }

  async function confirmHealthy(attempt: Attempt, port: number, version: string): Promise<void> {
    try {
      const response = await doFetch(`http://127.0.0.1:${port}/health`, {
        headers: { Authorization: `Bearer ${attempt.token}` }
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      if (attempt.failed || stopping) return
      attempt.port = port
      set({ status: 'ready', port, version })
    } catch (error) {
      fail(attempt, `core did not answer /health: ${String(error)}`)
      attempt.child.kill() // it is running but useless; the restart must not leave it behind
    }
  }

  function stop(): Promise<void> {
    stopping = true
    clearTimeout(restartTimer)
    return shutDown(active)
  }

  // Asks one attempt to exit, kills it after the timeout. Resolves once it is gone.
  function shutDown(attempt: Attempt | null): Promise<void> {
    if (!attempt || attempt.exited) return Promise.resolve()

    return new Promise((resolve) => {
      const killTimer = setTimeout(() => {
        log.warn(`core: did not exit within ${stopTimeoutMs / 1000} s, killing it`)
        attempt.child.kill()
        resolve()
      }, stopTimeoutMs)
      attempt.onExit = () => {
        clearTimeout(killTimer)
        resolve()
      }
      if (attempt.port === undefined) {
        attempt.child.kill() // never became reachable: nobody to ask politely
        return
      }
      // Polite first: lets core finish in-flight requests. Any failure falls back to the kill.
      doFetch(`http://127.0.0.1:${attempt.port}/shutdown`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${attempt.token}` }
      }).catch(() => attempt.child.kill())
    })
  }

  let restarting = false
  async function restart(): Promise<void> {
    // A double click must not launch two cores; after stop() the app is quitting.
    if (stopping || restarting) return
    restarting = true
    try {
      clearTimeout(restartTimer)
      const attempt = active
      // Marked failed first, so its exit is not mistaken for a crash (no counting, no automatic restart).
      if (attempt) attempt.failed = true
      await shutDown(attempt)
      crashTimes = []
      start() // checks `stopping` itself, in case the app began quitting while we waited
    } finally {
      restarting = false
    }
  }

  return { start, stop, restart, state: () => current }
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
