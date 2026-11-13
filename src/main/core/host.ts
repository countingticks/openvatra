// Finds or starts core.exe (the Go service) and keeps a connection to it. Core runs detached: it outlives the
// window, a dev reload and a crash of this process, and the next shell finds it again through data/core.json.
// Quit stops it. A core from another build or with other arguments is replaced.
import { spawn as nodeSpawn, type ChildProcessWithoutNullStreams } from 'child_process'
import { readFile as fsReadFile, realpath as fsRealpath } from 'fs/promises'
import { join, resolve } from 'path'
import { createInterface } from 'readline'

import type { CoreState } from '../../shared/core'

export type { CoreState }

/** Must match core/main.go: where core writes core.log. */
const logDirEnv = 'OPENVATRA_LOG_DIR'
/** Exit code of core and of its launcher when another core already holds the data folder. */
const exitRunning = 3

/** Wait before restart number 1, 2, ... after a crash. */
const restartDelaysMs = [1_000, 5_000]
/** Three crashes inside this window mean something is really wrong: restarting forever would only burn CPU. */
const crashWindowMs = 120_000
const maxCrashes = 3
/** How often a core that was asked to exit is checked for being gone. */
const pollMs = 250

const notAnswering = 'core is running but not answering'

export interface HostOptions {
  exePath: string
  /** coreArgs(): passed to the launcher and compared with core.json's args (the fingerprint), order kept. */
  args: string[]
  /** Passed to the launcher after `args` but never compared: ['--parent-pid', '<pid>'] in e2e runs. */
  launchOnlyArgs?: string[]
  /** <userData>/data: core.json is read from here. */
  dataDir: string
  /** Folder for core.log, the same one main.log lives in. */
  logsDir: string
  onState: (state: CoreState) => void
  /** Called each time a core is attached (also after a restart), e.g. to send it the config. */
  onReady?: () => void
  log: { info: (message: string) => void; warn: (message: string) => void }
  // Injected so tests can fake the process, the network, the disk and the clock-driven waits.
  spawn?: (exePath: string, args: string[], env: NodeJS.ProcessEnv) => ChildProcessWithoutNullStreams
  fetch?: typeof fetch
  readFile?: (path: string) => Promise<string>
  realpath?: (path: string) => Promise<string>
  isAlive?: (pid: number) => boolean
  kill?: (pid: number) => void
  /** How long the launcher may take; it waits 15 s itself and then says why, which beats racing it. */
  readyTimeoutMs?: number
  /** How long a core asked to shut down may take before it is killed. */
  stopTimeoutMs?: number
  healthIntervalMs?: number
  /** Timeout of /api/version and /health. */
  requestTimeoutMs?: number
}

export interface Host {
  start: () => void
  /** Asks core to shut down, kills it after the timeout. Resolves once it is gone; no restarts afterwards. */
  stop: () => Promise<void>
  /** Stops the attached core (if any) and connects again, forgetting earlier crashes. No-op once stop() ran. */
  restart: () => Promise<void>
  state: () => CoreState
  /** Any request to the attached core with its shell token. Rejects with 'core is not ready' otherwise. */
  request: (path: string, init?: RequestInit) => Promise<Response>
}

/** data/core.json as far as the shell needs it. */
interface Discovery {
  pid: number
  port: number
  token: string
  version: string
  exe: string
  args: string[]
}

/** A core this shell talks to. `token` is its shell token: never logged. */
interface Core {
  pid: number
  port: number
  token: string
}

type LaunchResult =
  | { kind: 'started'; core: Core; version: string }
  | { kind: 'running' }
  | { kind: 'crash'; reason: string }
  | { kind: 'problem'; reason: string }

export function createHost(options: HostOptions): Host {
  const { exePath, args, dataDir, logsDir, onState, log } = options
  const launchOnlyArgs = options.launchOnlyArgs ?? []
  const spawn =
    options.spawn ??
    ((exe: string, argv: string[], env: NodeJS.ProcessEnv) =>
      nodeSpawn(exe, argv, { env, windowsHide: true }))
  const doFetch = options.fetch ?? fetch
  const readFile = options.readFile ?? ((path: string) => fsReadFile(path, 'utf8'))
  const realpath = options.realpath ?? fsRealpath
  const isAlive = options.isAlive ?? processIsAlive
  const kill = options.kill ?? ((pid: number) => killProcess(pid, log))
  const readyTimeoutMs = options.readyTimeoutMs ?? 20_000
  const stopTimeoutMs = options.stopTimeoutMs ?? 8_000
  const requestTimeoutMs = options.requestTimeoutMs ?? 2_000

  let current: CoreState = { status: 'starting' }
  // Each connect is one attempt; async steps of an older attempt must never change the state of a newer one.
  let generation = 0
  let stopping = false
  let restarting = false
  let attached: Core | null = null
  let restartTimer: ReturnType<typeof setTimeout> | undefined
  let crashTimes: number[] = []

  function set(next: CoreState): void {
    current = next
    if (next.status === 'problem') log.warn(`core: ${next.reason}`)
    else log.info(`core: ${next.status}`)
    onState(next)
  }

  function live(gen: number): boolean {
    return gen === generation && !stopping
  }

  // Every way an attempt can go wrong ends here, once per attempt. Decides: connect again soon, or give up.
  function fail(gen: number, reason: string): void {
    if (!live(gen)) return
    generation++
    attached = null

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
    connectNow()
  }

  function connectNow(): void {
    const gen = ++generation
    connect(gen).catch((error: unknown) => fail(gen, `core could not be reached: ${String(error)}`))
  }

  async function connect(gen: number): Promise<void> {
    const ours = await ownExe()
    // A lost race (the launcher found another core starting) reads the file once more.
    for (let pass = 0; ; pass++) {
      const found = await readDiscovery()
      if (!live(gen)) return
      const answering = found !== null && (await answers(found))
      if (!live(gen)) return
      if (found && answering) {
        if (matches(found, ours)) return attach(gen, found, found.version)
        log.info(`core: replacing a core from another build or with other arguments (pid ${found.pid})`)
        await shutDown(found)
        if (!live(gen)) return
      }

      const result = await launch()
      if (!live(gen)) return
      if (result.kind === 'started') return attach(gen, result.core, result.version)
      if (result.kind === 'crash') return fail(gen, result.reason)
      if (result.kind === 'problem') {
        // Not worth retrying: the exe is missing or not runnable, and that does not fix itself.
        set({ status: 'problem', reason: result.reason })
        return
      }
      if (pass === 0) continue
      // A core holds the lock but does not answer: restarting would only meet it again. Restart kills it.
      if (!answering) {
        set({ status: 'problem', reason: notAnswering })
        return
      }
      return fail(gen, `core exited (code ${exitRunning}) before it was ready`)
    }
  }

  async function attach(gen: number, core: Core, version: string): Promise<void> {
    attached = core
    // The window talks to core itself, with a token that can do less than the shell token (scope ui).
    let uiToken: string
    try {
      uiToken = await issueUiToken(core)
    } catch (error) {
      fail(gen, `core did not issue a ui token: ${String(error)}`)
      return
    }
    if (!live(gen)) return
    set({
      status: 'ready',
      port: core.port,
      version,
      connection: { baseUrl: `http://127.0.0.1:${core.port}`, token: uiToken }
    })
    options.onReady?.()
  }

  function launch(): Promise<LaunchResult> {
    return new Promise((done) => {
      let child: ChildProcessWithoutNullStreams
      try {
        child = spawn(exePath, ['--detach', ...args, ...launchOnlyArgs], {
          ...process.env,
          [logDirEnv]: logsDir
        })
      } catch (error) {
        done({ kind: 'problem', reason: `core could not be started: ${String(error)}` })
        return
      }

      let settled = false
      const finish = (result: LaunchResult): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        done(result)
      }
      const timer = setTimeout(() => {
        child.kill()
        finish({ kind: 'crash', reason: `core did not report ready within ${readyTimeoutMs / 1000} s` })
      }, readyTimeoutMs)

      let ready: ReadyLine | null = null
      // stdout is a stream of chunks, not lines; readline cuts it into lines.
      createInterface({ input: child.stdout }).on('line', (line) => {
        ready ??= parseReadyLine(line)
      })
      createInterface({ input: child.stderr }).on('line', (line) => log.warn(`core launcher: ${line}`))

      child.on('error', (error) => {
        finish({ kind: 'problem', reason: `core could not be started: ${error.message}` })
      })
      // 'close', not 'exit': it comes after stdout has been read to the end, so the ready line is in.
      child.on('close', (code: number | null) => {
        if (settled) return
        clearTimeout(timer)
        if (code === 0 && ready) void startedCore(ready).then(finish)
        else if (code === exitRunning) finish({ kind: 'running' })
        else finish({ kind: 'crash', reason: `core exited (code ${code}) before it was ready` })
      })
    })
  }

  async function startedCore(ready: ReadyLine): Promise<LaunchResult> {
    const found = await readDiscovery()
    if (!found || found.pid !== ready.pid)
      return { kind: 'crash', reason: 'core.json does not match the core that started' }
    return {
      kind: 'started',
      core: { pid: found.pid, port: found.port, token: found.token },
      version: ready.version
    }
  }

  async function readDiscovery(): Promise<Discovery | null> {
    let text: string
    try {
      text = await readFile(join(dataDir, 'core.json'))
    } catch {
      return null // no core has run on this folder, or the last one exited cleanly
    }
    return parseDiscovery(text)
  }

  async function ownExe(): Promise<string> {
    try {
      return await realpath(exePath)
    } catch {
      return resolve(exePath)
    }
  }

  function matches(found: Discovery, ours: string): boolean {
    return (
      resolve(found.exe).toLowerCase() === ours.toLowerCase() &&
      found.args.length === args.length &&
      found.args.every((arg, index) => arg === args[index])
    )
  }

  function authorized(core: Core, init: RequestInit = {}): RequestInit {
    const headers = new Headers(init.headers)
    headers.set('Authorization', `Bearer ${core.token}`)
    return { ...init, headers }
  }

  // A request that gives up after requestTimeoutMs. A hung core accepts the connection but never answers.
  async function timedFetch(core: Core, path: string, init: RequestInit = {}): Promise<Response> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), requestTimeoutMs)
    try {
      return await doFetch(`http://127.0.0.1:${core.port}${path}`, {
        ...authorized(core, init),
        signal: controller.signal
      })
    } finally {
      clearTimeout(timer)
    }
  }

  async function answers(core: Core): Promise<boolean> {
    try {
      return (await timedFetch(core, '/api/version')).status === 200
    } catch {
      return false
    }
  }

  async function issueUiToken(core: Core): Promise<string> {
    const response = await timedFetch(core, '/api/tokens', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scope: 'ui' })
    })
    if (response.status !== 201) throw new Error(`HTTP ${response.status}`)
    const data: unknown = await response.json()
    const token =
      typeof data === 'object' && data !== null ? (data as Record<string, unknown>).token : undefined
    if (typeof token !== 'string' || !/^[0-9a-f]{64}$/.test(token))
      throw new Error('no valid token in the answer')
    return token
  }

  // Polite first, so core can finish in-flight requests and close its database. "Gone" means the pid has exited:
  // /health stops answering before core releases its lock, and a launch right then would only meet that lock.
  async function shutDown(core: Core): Promise<void> {
    try {
      await timedFetch(core, '/shutdown', { method: 'POST' })
    } catch {
      // unreachable or already exiting: the wait below decides
    }
    if (await waitGone(core.pid)) return
    log.warn(`core: did not exit within ${stopTimeoutMs / 1000} s, killing it`)
    kill(core.pid)
  }

  async function waitGone(pid: number): Promise<boolean> {
    for (let waited = 0; ; waited += pollMs) {
      if (!isAlive(pid)) return true
      if (waited >= stopTimeoutMs) return false
      await new Promise((wake) => setTimeout(wake, pollMs))
    }
  }

  async function stop(): Promise<void> {
    stopping = true
    clearTimeout(restartTimer)
    const core = attached
    attached = null
    if (core) await shutDown(core)
  }

  async function restart(): Promise<void> {
    // A double click must not start two connects; after stop() the app is quitting.
    if (stopping || restarting) return
    restarting = true
    try {
      clearTimeout(restartTimer)
      generation++ // ends the current attempt without counting a crash
      // Said before the old core goes: requests must be refused instead of reaching a core that is exiting.
      set({ status: 'starting' })
      const core = attached
      attached = null
      if (core) await shutDown(core)
      crashTimes = []
      if (!stopping) connectNow()
    } finally {
      restarting = false
    }
  }

  async function request(path: string, init: RequestInit = {}): Promise<Response> {
    const core = attached
    if (current.status !== 'ready' || !core) throw new Error('core is not ready')
    return doFetch(`http://127.0.0.1:${core.port}${path}`, authorized(core, init))
  }

  return { start, stop, restart, request, state: () => current }
}

interface ReadyLine {
  port: number
  pid: number
  version: string
}

/** The launcher's `{"event":"ready","port":…,"pid":…,"version":"…"}`; any other line gives null. */
function parseReadyLine(line: string): ReadyLine | null {
  try {
    const data: unknown = JSON.parse(line)
    if (typeof data !== 'object' || data === null) return null
    const { event, port, pid, version } = data as Record<string, unknown>
    if (
      event !== 'ready' ||
      typeof port !== 'number' ||
      typeof pid !== 'number' ||
      typeof version !== 'string'
    )
      return null
    return { port, pid, version }
  } catch {
    return null // not JSON: some other output line
  }
}

function parseDiscovery(text: string): Discovery | null {
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    return null
  }
  if (typeof data !== 'object' || data === null) return null
  const { pid, port, token, version, exe, args } = data as Record<string, unknown>
  if (
    !Number.isInteger(pid) ||
    (pid as number) <= 0 ||
    !Number.isInteger(port) ||
    (port as number) < 1 ||
    (port as number) > 65_535 ||
    typeof token !== 'string' ||
    !/^[0-9a-f]{64}$/.test(token) ||
    typeof version !== 'string' ||
    typeof exe !== 'string' ||
    !Array.isArray(args) ||
    !args.every((arg) => typeof arg === 'string')
  )
    return null
  return { pid: pid as number, port: port as number, token, version, exe, args: args as string[] }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function killProcess(pid: number, log: HostOptions['log']): void {
  try {
    process.kill(pid)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH')
      log.warn(`core: could not kill pid ${pid}: ${String(error)}`)
  }
}
