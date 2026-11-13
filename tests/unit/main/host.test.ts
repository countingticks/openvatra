import { EventEmitter } from 'events'
import { PassThrough } from 'stream'
import type { ChildProcessWithoutNullStreams } from 'child_process'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { createHost, type CoreState, type Host } from '../../../src/main/core/host'

// A stand-in for the launcher process: we write to its stdout and end it with exit(code) ourselves.
interface FakeChild {
  child: EventEmitter & {
    stdout: PassThrough
    stderr: PassThrough
    kill: ReturnType<typeof vi.fn>
    exit: (code: number) => void
  }
  process: ChildProcessWithoutNullStreams
}

function fakeChild(): FakeChild {
  const child = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(),
    exit: (code: number) => {
      child.stdout.end()
      child.stderr.end()
      child.emit('exit', code, null)
      child.emit('close', code, null)
    }
  })
  return { child, process: child as unknown as ChildProcessWithoutNullStreams }
}

const exe = 'C:\\app\\resources\\core\\core.exe'
const args = ['--llama-manifest', 'C:\\app\\llama.json', '--data-dir', 'C:\\data']
const launchOnlyArgs = ['--parent-pid', '77']
/** The shell token in the core.json of the core that is already running (pid 4242). */
const fileToken = 'a'.repeat(64)
/** The shell token in the core.json a launched core (pid 5151) writes. */
const launchedToken = 'd'.repeat(64)
/** The ui tokens the fake core issues, in order: one per POST /api/tokens. */
const uiTokens = ['b'.repeat(64), 'c'.repeat(64)]

function discovery(fields: Record<string, unknown> = {}): string {
  return JSON.stringify({
    pid: 4242,
    port: 53121,
    token: fileToken,
    version: '0.1.0',
    api: 1,
    exe,
    args,
    startedAt: '2026-11-13T09:12:00Z',
    ...fields
  })
}

const readyLine = (pid = 5151, port = 53122, version = '0.2.0'): string =>
  JSON.stringify({ event: 'ready', port, pid, version }) + '\n'

/** What the fake network does with one request: a response, a refused connection, or no answer at all. */
type Answer = Partial<Response> | 'refuse' | 'silent'

interface World {
  /** core.json's content, or null when there is none. */
  file: string | null
  alive: Set<number>
  /** Overrides the default answers (everything OK, /api/tokens issues the next ui token). */
  answer: (url: string, init: RequestInit) => Answer | undefined
}

/** A few rounds of timers and microtasks: enough for a read, a request and a state change to settle. */
async function settle(): Promise<void> {
  for (let round = 0; round < 10; round++) await vi.advanceTimersByTimeAsync(0)
}

interface SetUp {
  world: World
  host: Host
  states: CoreState[]
  children: FakeChild[]
  spawn: Mock
  fetch: Mock<typeof fetch>
  kill: Mock
  onReady: Mock
  log: { info: Mock; warn: Mock }
}

function setUp(world: Partial<World> = {}, spawnImpl?: () => ChildProcessWithoutNullStreams): SetUp {
  const full: World = {
    file: null,
    alive: new Set([4242]),
    answer: () => undefined,
    ...world
  }
  const states: CoreState[] = []
  const children: FakeChild[] = []
  const spawn = vi.fn(
    spawnImpl ??
      (() => {
        const fake = fakeChild()
        children.push(fake)
        return fake.process
      })
  )
  let issued = 0
  const fetchMock = vi.fn<typeof fetch>((input, init: RequestInit = {}) => {
    const url = String(input)
    const answer =
      full.answer(url, init) ??
      (url.endsWith('/api/tokens')
        ? { status: 201, json: async () => ({ token: uiTokens[issued++ % uiTokens.length] }) }
        : { status: url.endsWith('/shutdown') ? 202 : 200 })
    if (answer === 'refuse') return Promise.reject(new TypeError('fetch failed'))
    if (answer === 'silent')
      return new Promise<Response>((_, reject) =>
        init.signal?.addEventListener('abort', () => reject(new Error('aborted')))
      )
    return Promise.resolve({ ok: answer.status === 200, ...answer } as Response)
  })
  const kill = vi.fn()
  const onReady = vi.fn()
  const log = { info: vi.fn(), warn: vi.fn() }
  const host = createHost({
    exePath: exe,
    args,
    launchOnlyArgs,
    dataDir: 'C:\\data',
    logsDir: 'logs',
    onState: (state) => states.push(state),
    onReady,
    log,
    spawn,
    fetch: fetchMock,
    readFile: async () => {
      if (full.file === null) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      return full.file
    },
    realpath: async (path) => path,
    isAlive: (pid) => full.alive.has(pid),
    kill
  })
  host.start()
  return { world: full, host, states, children, spawn, fetch: fetchMock, kill, onReady, log }
}

/** The launcher starts a core (pid 5151) that writes its core.json, prints the ready line and exits 0. */
async function launcherSucceeds(
  set: SetUp,
  child: FakeChild,
  fileFields: Record<string, unknown> = {}
): Promise<void> {
  set.world.file = discovery({
    pid: 5151,
    port: 53122,
    token: launchedToken,
    version: '9.9.9',
    ...fileFields
  })
  set.world.alive.add(5151)
  child.child.stdout.write(readyLine())
  await settle()
  child.child.exit(0)
  await settle()
}

function requests(fetchMock: Mock<typeof fetch>, path: string): [string, RequestInit][] {
  return fetchMock.mock.calls
    .map(([input, init]) => [String(input), init ?? {}] as [string, RequestInit])
    .filter(([url]) => url.endsWith(path))
}

function bearer(init: RequestInit): string | null {
  return new Headers(init.headers).get('Authorization')
}

describe('core host: connect', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it("attaches to a running core that answers and matches, with the file's port and version", async () => {
    const { states, spawn, onReady } = setUp({ file: discovery() })
    await settle()
    expect(spawn).not.toHaveBeenCalled()
    expect(states.at(-1)).toEqual({
      status: 'ready',
      port: 53121,
      version: '0.1.0',
      connection: { baseUrl: 'http://127.0.0.1:53121', token: uiTokens[0] }
    })
    expect(onReady).toHaveBeenCalledTimes(1)
  })

  it('launches a detached core when there is no core.json', async () => {
    const { states, spawn } = setUp()
    await settle()
    expect(states[0]).toEqual({ status: 'starting' })
    expect(spawn).toHaveBeenCalledTimes(1)
    const [exePath, argv, env] = spawn.mock.calls[0] as [string, string[], NodeJS.ProcessEnv]
    expect(exePath).toBe(exe)
    expect(argv).toEqual(['--detach', ...args, ...launchOnlyArgs])
    expect(env['OPENVATRA_LOG_DIR']).toBe('logs')
  })

  it.each([
    ['not JSON', '{"pid": 42'],
    ['a 63-char token', discovery({ token: 'a'.repeat(63) })]
  ])('launches when core.json is %s', async (_, file) => {
    const { spawn } = setUp({ file })
    await settle()
    expect(spawn).toHaveBeenCalledTimes(1)
  })

  it.each<[string, Answer]>([
    ['refused', 'refuse'],
    ['answering 500', { status: 500 }]
  ])('launches when /api/version is %s', async (_, answer) => {
    const { spawn } = setUp({
      file: discovery(),
      answer: (url) => (url.endsWith('/api/version') ? answer : undefined)
    })
    await settle()
    expect(spawn).toHaveBeenCalledTimes(1)
  })

  it('launches when /api/version is silent past 2 s', async () => {
    const { spawn } = setUp({
      file: discovery(),
      answer: (url) => (url.endsWith('/api/version') ? 'silent' : undefined)
    })
    await settle()
    await vi.advanceTimersByTimeAsync(1_990)
    expect(spawn).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(10)
    await settle()
    expect(spawn).toHaveBeenCalledTimes(1)
  })

  it('treats an exe path that differs only in case as the same core', async () => {
    const { spawn, fetch, states } = setUp({ file: discovery({ exe: exe.toUpperCase() }) })
    await settle()
    expect(spawn).not.toHaveBeenCalled()
    expect(requests(fetch, '/shutdown')).toHaveLength(0)
    expect(states.at(-1)?.status).toBe('ready')
  })

  it.each([
    ['another exe', { exe: 'C:\\other\\core.exe' }],
    ['one extra arg', { args: [...args, '--test-catalog'] }]
  ])('replaces a core with %s: /shutdown with its token, launch once its pid is gone', async (_, fields) => {
    const { world, spawn, fetch, log } = setUp({ file: discovery(fields) })
    await settle()
    const shutdowns = requests(fetch, '/shutdown')
    expect(shutdowns).toHaveLength(1)
    expect(shutdowns[0][0]).toBe('http://127.0.0.1:53121/shutdown')
    expect(shutdowns[0][1].method).toBe('POST')
    expect(bearer(shutdowns[0][1])).toBe(`Bearer ${fileToken}`)
    expect(log.info).toHaveBeenCalledWith(
      'core: replacing a core from another build or with other arguments (pid 4242)'
    )

    await vi.advanceTimersByTimeAsync(1_000)
    expect(spawn).not.toHaveBeenCalled() // still alive

    world.alive.delete(4242)
    await vi.advanceTimersByTimeAsync(250)
    await settle()
    expect(spawn).toHaveBeenCalledTimes(1)
  })

  it('kills a replaced core that never exits after 8 s, then launches', async () => {
    const { spawn, kill } = setUp({ file: discovery({ exe: 'C:\\other\\core.exe' }) })
    await settle()
    await vi.advanceTimersByTimeAsync(7_750)
    expect(kill).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(250)
    await settle()
    expect(kill).toHaveBeenCalledWith(4242)
    expect(spawn).toHaveBeenCalledTimes(1)
  })

  it('attaches after a launch: port and token from core.json, version from the ready line', async () => {
    const set = setUp()
    await settle()
    await launcherSucceeds(set, set.children[0])
    expect(set.states.at(-1)).toEqual({
      status: 'ready',
      port: 53122,
      version: '0.2.0',
      connection: { baseUrl: 'http://127.0.0.1:53122', token: uiTokens[0] }
    })
    const [, init] = requests(set.fetch, '/api/tokens')[0]
    expect(bearer(init)).toBe(`Bearer ${launchedToken}`)
  })

  it('counts a launch whose core.json names another pid as a crash', async () => {
    const set = setUp()
    await settle()
    await launcherSucceeds(set, set.children[0], { pid: 6000 })
    expect(set.states.at(-1)).toEqual({
      status: 'problem',
      reason: expect.stringContaining('does not match')
    })
  })

  it('reads core.json again after the launcher lost a race (exit 3) and attaches to that core', async () => {
    const { world, children, spawn, states } = setUp()
    await settle()
    world.file = discovery()
    children[0].child.exit(3)
    await settle()
    expect(spawn).toHaveBeenCalledTimes(1)
    expect(states.at(-1)).toMatchObject({ status: 'ready', port: 53121 })
  })

  it('waits for Restart when a core holds the folder but does not answer (exit 3 twice)', async () => {
    const { children, spawn, states } = setUp({
      file: discovery(),
      answer: (url) => (url.endsWith('/api/version') ? 'silent' : undefined)
    })
    await vi.advanceTimersByTimeAsync(2_000)
    await settle()
    children[0].child.exit(3)
    await settle()
    await vi.advanceTimersByTimeAsync(2_000)
    await settle()
    expect(spawn).toHaveBeenCalledTimes(2)
    children[1].child.exit(3)
    await settle()
    expect(states.at(-1)).toEqual({ status: 'problem', reason: 'core is running but not answering' })

    await vi.advanceTimersByTimeAsync(60_000)
    expect(spawn).toHaveBeenCalledTimes(2)
  })

  it('connects again 1 s after the launcher fails, and gives up after 3 crashes in 2 minutes', async () => {
    const { children, spawn, states } = setUp()
    await settle()
    children[0].child.exit(1)
    await settle()
    expect(states.at(-1)).toEqual({ status: 'problem', reason: 'core exited (code 1) before it was ready' })
    await vi.advanceTimersByTimeAsync(999)
    expect(spawn).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    await settle()
    expect(spawn).toHaveBeenCalledTimes(2)

    children[1].child.exit(1)
    await settle()
    await vi.advanceTimersByTimeAsync(5_000)
    await settle()
    expect(spawn).toHaveBeenCalledTimes(3)

    children[2].child.exit(1)
    await settle()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(spawn).toHaveBeenCalledTimes(3)
    expect(states.at(-1)).toMatchObject({
      status: 'problem',
      reason: expect.stringContaining('giving up after 3 crashes in 2 minutes')
    })
  })

  it('kills a launcher silent past 20 s and counts it as a crash', async () => {
    const { children, spawn, states } = setUp()
    await settle()
    await vi.advanceTimersByTimeAsync(19_999)
    expect(children[0].child.kill).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    await settle()
    expect(children[0].child.kill).toHaveBeenCalled()
    expect(states.at(-1)).toEqual({ status: 'problem', reason: 'core did not report ready within 20 s' })
    await vi.advanceTimersByTimeAsync(1_000)
    await settle()
    expect(spawn).toHaveBeenCalledTimes(2)
  })

  it('reports a problem without retrying when the exe cannot be spawned', async () => {
    const { spawn, states } = setUp({}, () => {
      throw new Error('ENOENT')
    })
    await settle()
    expect(states.at(-1)).toEqual({
      status: 'problem',
      reason: expect.stringContaining('core could not be started')
    })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(spawn).toHaveBeenCalledTimes(1)
  })

  it('counts a 500 from POST /api/tokens as a crash', async () => {
    const { states } = setUp({
      file: discovery(),
      answer: (url) => (url.endsWith('/api/tokens') ? { status: 500 } : undefined)
    })
    await settle()
    expect(states.at(-1)).toEqual({
      status: 'problem',
      reason: expect.stringContaining('core did not issue a ui token')
    })
  })

  it('refuses requests before ready, then sends them with the shell token to the attached port', async () => {
    const world: Partial<World> = { file: null }
    const set = setUp(world)
    await expect(set.host.request('/api/catalog')).rejects.toThrow('core is not ready')

    await settle()
    await launcherSucceeds(set, set.children[0])
    await set.host.request('/api/catalog')
    const [url, init] = set.fetch.mock.lastCall as [string, RequestInit]
    expect(url).toBe('http://127.0.0.1:53122/api/catalog')
    expect(bearer(init)).toBe(`Bearer ${launchedToken}`)
  })

  it('never logs the shell token or a ui token', async () => {
    const set = setUp({ file: discovery({ exe: 'C:\\other\\core.exe' }) })
    await settle()
    set.world.alive.delete(4242)
    await vi.advanceTimersByTimeAsync(250)
    await settle()
    set.children[0].child.stderr.write('some launcher complaint\n')
    await launcherSucceeds(set, set.children[0])
    expect(set.states.at(-1)?.status).toBe('ready')
    set.world.alive.delete(5151)
    await set.host.restart()
    await settle()

    const lines = [...set.log.info.mock.calls, ...set.log.warn.mock.calls].map((call) => String(call[0]))
    expect(lines).toContain('core launcher: some launcher complaint')
    for (const token of [fileToken, launchedToken, ...uiTokens])
      expect(lines.some((line) => line.includes(token))).toBe(false)
  })
})

describe('core host: health watch', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  /** Attached to the file's core; /health answers what `health` says for each check in turn, then 200. */
  async function attachedWith(health: Answer[]): Promise<SetUp> {
    const queue = [...health]
    const set = setUp({
      file: discovery(),
      answer: (url) => (url.endsWith('/health') ? queue.shift() : undefined)
    })
    await settle()
    expect(set.states.at(-1)?.status).toBe('ready')
    return set
  }

  it('stays ready after one failed /health followed by a 200', async () => {
    const { states, fetch } = await attachedWith([{ status: 500 }])
    await vi.advanceTimersByTimeAsync(10_000)
    await settle()
    expect(requests(fetch, '/health')).toHaveLength(2)
    expect(states.map((state) => state.status)).not.toContain('problem')
  })

  it('counts two failed /health in a row as a crash, then reconnects to the running core after 1 s', async () => {
    const { states, fetch, spawn } = await attachedWith(['refuse', { status: 500 }])
    await vi.advanceTimersByTimeAsync(10_000)
    await settle()
    const [url, init] = requests(fetch, '/health')[0]
    expect(url).toBe('http://127.0.0.1:53121/health')
    expect(bearer(init)).toBe(`Bearer ${fileToken}`)
    expect(states.at(-1)).toEqual({ status: 'problem', reason: 'core stopped answering' })

    await vi.advanceTimersByTimeAsync(1_000)
    await settle()
    expect(spawn).not.toHaveBeenCalled()
    expect(states.at(-1)).toMatchObject({ status: 'ready', port: 53121 })
  })

  it('counts a /health silent past 2 s as a miss', async () => {
    const { states } = await attachedWith(['silent', 'silent'])
    await vi.advanceTimersByTimeAsync(5_000 + 2_000 + 5_000 + 1_999)
    expect(states.at(-1)?.status).toBe('ready')
    await vi.advanceTimersByTimeAsync(1)
    await settle()
    expect(states.at(-1)).toEqual({ status: 'problem', reason: 'core stopped answering' })
  })

  it('sends no /health after stop()', async () => {
    const { world, host, fetch } = await attachedWith([])
    world.alive.delete(4242)
    await host.stop()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(requests(fetch, '/health')).toHaveLength(0)
  })
})

describe('core host: stop and restart', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  /** Core behaves like the real one on POST /shutdown: it exits at once and removes its core.json. */
  function exitOnShutdown(world: World): void {
    world.answer = (url) => {
      if (url.endsWith('/shutdown')) {
        world.file = null
        world.alive.clear()
      }
      return undefined
    }
  }

  it('stop() posts /shutdown with the shell token and resolves once the pid is gone, without kill', async () => {
    const { world, host, fetch, kill } = setUp({ file: discovery() })
    await settle()
    const stopped = vi.fn()
    void host.stop().then(stopped)
    await settle()
    const [url, init] = requests(fetch, '/shutdown')[0]
    expect(url).toBe('http://127.0.0.1:53121/shutdown')
    expect(bearer(init)).toBe(`Bearer ${fileToken}`)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(stopped).not.toHaveBeenCalled()

    world.alive.delete(4242)
    await vi.advanceTimersByTimeAsync(250)
    expect(stopped).toHaveBeenCalled()
    expect(kill).not.toHaveBeenCalled()
  })

  it('stop() kills a core that never exits after 8 s, then resolves', async () => {
    const { host, kill, log } = setUp({ file: discovery() })
    await settle()
    const stopped = vi.fn()
    void host.stop().then(stopped)
    await settle()
    await vi.advanceTimersByTimeAsync(7_750)
    expect(kill).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(250)
    expect(kill).toHaveBeenCalledWith(4242)
    expect(stopped).toHaveBeenCalled()
    expect(log.warn).toHaveBeenCalledWith('core: did not exit within 8 s, killing it')
  })

  it('stop() during a launch waits for the ready line, then shuts that core down; no connect afterwards', async () => {
    const set = setUp()
    await settle()
    const stopped = vi.fn()
    void set.host.stop().then(stopped)
    await settle()
    expect(stopped).not.toHaveBeenCalled()

    await launcherSucceeds(set, set.children[0])
    const [url, init] = requests(set.fetch, '/shutdown')[0]
    expect(url).toBe('http://127.0.0.1:53122/shutdown')
    expect(bearer(init)).toBe(`Bearer ${launchedToken}`)
    set.world.alive.delete(5151)
    await vi.advanceTimersByTimeAsync(250)
    expect(stopped).toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(60_000)
    expect(set.spawn).toHaveBeenCalledTimes(1)
    expect(requests(set.fetch, '/api/tokens')).toHaveLength(0)
    expect(set.states.map((state) => state.status)).not.toContain('ready')
  })

  it('stop() with nothing attached resolves without a request', async () => {
    const { host, fetch } = setUp({}, () => {
      throw new Error('ENOENT')
    })
    await settle()
    await host.stop()
    expect(fetch).not.toHaveBeenCalled()
  })

  it('restart() shuts the attached core down, connects again and forgets earlier crashes', async () => {
    const set = setUp()
    await settle()
    set.children[0].child.exit(1)
    await settle()
    await vi.advanceTimersByTimeAsync(1_000)
    await settle()
    set.children[1].child.exit(1)
    await settle()
    await vi.advanceTimersByTimeAsync(5_000)
    await settle()
    await launcherSucceeds(set, set.children[2])
    expect(set.states.at(-1)?.status).toBe('ready')

    exitOnShutdown(set.world)
    await set.host.restart()
    await settle()
    expect(requests(set.fetch, '/shutdown')).toHaveLength(1)
    expect(set.spawn).toHaveBeenCalledTimes(4)

    // Two crashes after the restart still lead to a reconnect: the old ones were forgotten.
    set.children[3].child.exit(1)
    await settle()
    await vi.advanceTimersByTimeAsync(1_000)
    await settle()
    expect(set.spawn).toHaveBeenCalledTimes(5)
    set.children[4].child.exit(1)
    await settle()
    await vi.advanceTimersByTimeAsync(5_000)
    await settle()
    expect(set.spawn).toHaveBeenCalledTimes(6)
    set.children[5].child.exit(1)
    await settle()
    expect(set.states.at(-1)).toMatchObject({
      status: 'problem',
      reason: expect.stringContaining('giving up')
    })
  })

  it("restart() of a core that is running but not answering kills the file's pid, then launches", async () => {
    const set = setUp({
      file: discovery(),
      answer: (url) => (url.endsWith('/api/version') ? 'silent' : undefined)
    })
    await vi.advanceTimersByTimeAsync(2_000)
    await settle()
    set.children[0].child.exit(3)
    await settle()
    await vi.advanceTimersByTimeAsync(2_000)
    await settle()
    set.children[1].child.exit(3)
    await settle()
    expect(set.states.at(-1)).toEqual({ status: 'problem', reason: 'core is running but not answering' })

    set.kill.mockImplementation((pid: number) => set.world.alive.delete(pid))
    set.world.answer = (url) => (url.endsWith('/api/version') ? 'refuse' : undefined)
    await set.host.restart()
    expect(set.kill).toHaveBeenCalledWith(4242)
    await settle()
    expect(set.spawn).toHaveBeenCalledTimes(3)
  })

  it('ignores a second restart() while the first runs: one shutdown, one connect', async () => {
    const set = setUp({ file: discovery() })
    await settle()
    exitOnShutdown(set.world)
    void set.host.restart()
    void set.host.restart()
    await settle()
    expect(requests(set.fetch, '/shutdown')).toHaveLength(1)
    expect(set.spawn).toHaveBeenCalledTimes(1)
  })

  it('restart() after stop() does nothing', async () => {
    const set = setUp({ file: discovery() })
    await settle()
    exitOnShutdown(set.world)
    await set.host.stop()
    const requestsBefore = set.fetch.mock.calls.length
    const statesBefore = set.states.length
    await set.host.restart()
    await settle()
    expect(set.fetch.mock.calls.length).toBe(requestsBefore)
    expect(set.states.length).toBe(statesBefore)
    expect(set.spawn).not.toHaveBeenCalled()
  })
})
