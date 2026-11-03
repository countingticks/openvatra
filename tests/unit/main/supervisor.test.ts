import { EventEmitter } from 'events'
import { PassThrough } from 'stream'
import type { ChildProcessWithoutNullStreams } from 'child_process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createSupervisor, type CoreState, type Supervisor } from '../../../src/main/core/supervisor'

// A stand-in for the child process: we write to its stdout and emit 'exit' ourselves.
interface FakeChild {
  child: EventEmitter & { stdout: PassThrough; stderr: PassThrough; kill: ReturnType<typeof vi.fn> }
  process: ChildProcessWithoutNullStreams
}

function fakeChild(): FakeChild {
  const child = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn()
  })
  return { child, process: child as unknown as ChildProcessWithoutNullStreams }
}

const readyLine = (port = 53121): string => JSON.stringify({ event: 'ready', port, version: '0.1.0' }) + '\n'

interface SetUp extends FakeChild {
  states: CoreState[]
  spawn: ReturnType<typeof vi.fn>
  fetch: typeof fetch
  supervisor: Supervisor
}

function setUp(fetchImpl: typeof fetch = vi.fn().mockResolvedValue({ ok: true, status: 200 })): SetUp {
  const fake = fakeChild()
  const states: CoreState[] = []
  const spawn = vi.fn().mockReturnValue(fake.process)
  const supervisor = createSupervisor({
    exePath: 'core.exe',
    logsDir: 'logs',
    onState: (state) => states.push(state),
    log: { info: vi.fn(), warn: vi.fn() },
    spawn,
    fetch: fetchImpl
  })
  supervisor.start()
  return { ...fake, states, spawn, supervisor, fetch: fetchImpl }
}

describe('core supervisor', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('starts as "starting" and passes a random token in the environment', () => {
    const { states, spawn } = setUp()
    expect(states).toEqual([{ status: 'starting' }])
    const env = spawn.mock.calls[0][1] as NodeJS.ProcessEnv
    expect(env['OPENVATRA_CORE_TOKEN']).toMatch(/^[0-9a-f]{64}$/)
    expect(env['OPENVATRA_LOG_DIR']).toBe('logs')
  })

  it('becomes ready after the ready line and an authorized /health call', async () => {
    const { child, states, spawn, fetch } = setUp()
    // Chunks need not follow line boundaries.
    child.stdout.write('{"event":"rea')
    child.stdout.write('dy","port":53121,"version":"0.1.0"}\n')
    await vi.advanceTimersByTimeAsync(0)

    const token = (spawn.mock.calls[0][1] as NodeJS.ProcessEnv)['OPENVATRA_CORE_TOKEN']
    expect(fetch).toHaveBeenCalledWith('http://127.0.0.1:53121/health', {
      headers: { Authorization: `Bearer ${token}` }
    })
    expect(states.at(-1)).toEqual({ status: 'ready', port: 53121, version: '0.1.0' })
  })

  it('ignores output that is not the ready line', async () => {
    const { child, states, fetch } = setUp()
    child.stdout.write('hello\n{"event":"other"}\n')
    await vi.advanceTimersByTimeAsync(0)
    expect(fetch).not.toHaveBeenCalled()
    expect(states).toEqual([{ status: 'starting' }])
  })

  it('reports a problem when /health does not answer ok', async () => {
    const { child, states } = setUp(vi.fn().mockResolvedValue({ ok: false, status: 401 }))
    child.stdout.write(readyLine())
    await vi.advanceTimersByTimeAsync(0)
    expect(states.at(-1)).toMatchObject({ status: 'problem', reason: expect.stringContaining('HTTP 401') })
  })

  it('reports a problem when core exits before it is ready', () => {
    const { child, states } = setUp()
    child.emit('exit', 1)
    expect(states.at(-1)).toEqual({ status: 'problem', reason: 'core exited (code 1) before it was ready' })
  })

  it('reports a problem and kills core when no ready line comes within 15 s', async () => {
    const { child, states } = setUp()
    await vi.advanceTimersByTimeAsync(15_000)
    expect(states.at(-1)).toMatchObject({ status: 'problem', reason: expect.stringContaining('15 s') })
    expect(child.kill).toHaveBeenCalled()
  })

  it('does not time out once ready', async () => {
    const { child, states } = setUp()
    child.stdout.write(readyLine())
    await vi.advanceTimersByTimeAsync(20_000)
    expect(states.at(-1)?.status).toBe('ready')
    expect(child.kill).not.toHaveBeenCalled()
  })

  it('reports a problem when the program cannot be spawned', () => {
    const states: CoreState[] = []
    createSupervisor({
      exePath: 'missing.exe',
      logsDir: 'logs',
      onState: (state) => states.push(state),
      log: { info: vi.fn(), warn: vi.fn() },
      spawn: () => {
        throw new Error('ENOENT')
      }
    }).start()
    expect(states.at(-1)).toMatchObject({ status: 'problem', reason: expect.stringContaining('ENOENT') })
  })

  describe('after a crash', () => {
    // Every spawn call returns a fresh fake child, so restarts can be observed.
    function setUpMany(): SetUp & { children: FakeChild[] } {
      const children: FakeChild[] = []
      const states: CoreState[] = []
      const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 200 })
      const spawn = vi.fn().mockImplementation(() => {
        const fake = fakeChild()
        children.push(fake)
        return fake.process
      })
      const supervisor = createSupervisor({
        exePath: 'core.exe',
        logsDir: 'logs',
        onState: (state) => states.push(state),
        log: { info: vi.fn(), warn: vi.fn() },
        spawn,
        fetch: fetchImpl
      })
      supervisor.start()
      return { ...children[0], children, states, spawn, supervisor, fetch: fetchImpl }
    }

    it('restarts after 1 s, then after 5 s, and gives up on the third crash', async () => {
      const { children, states, spawn } = setUpMany()
      children[0].child.emit('exit', 1)
      await vi.advanceTimersByTimeAsync(999)
      expect(spawn).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(1)
      expect(spawn).toHaveBeenCalledTimes(2)

      children[1].child.emit('exit', 1)
      await vi.advanceTimersByTimeAsync(4_999)
      expect(spawn).toHaveBeenCalledTimes(2)
      await vi.advanceTimersByTimeAsync(1)
      expect(spawn).toHaveBeenCalledTimes(3)

      children[2].child.emit('exit', 1)
      await vi.advanceTimersByTimeAsync(60_000)
      expect(spawn).toHaveBeenCalledTimes(3)
      expect(states.at(-1)).toMatchObject({
        status: 'problem',
        reason: expect.stringContaining('giving up after 3 crashes')
      })
    })

    it('restarts a core that crashes after it was ready', async () => {
      const { children, states, spawn } = setUpMany()
      children[0].child.stdout.write(readyLine())
      await vi.advanceTimersByTimeAsync(0)
      expect(states.at(-1)?.status).toBe('ready')

      children[0].child.emit('exit', 3)
      expect(states.at(-1)).toEqual({ status: 'problem', reason: 'core exited unexpectedly (code 3)' })
      await vi.advanceTimersByTimeAsync(1_000)
      expect(spawn).toHaveBeenCalledTimes(2)
      expect(states.at(-1)).toEqual({ status: 'starting' })
    })

    it('forgets crashes older than 2 minutes', async () => {
      const { children, spawn } = setUpMany()
      children[0].child.emit('exit', 1)
      await vi.advanceTimersByTimeAsync(1_000)
      children[1].child.emit('exit', 1)
      await vi.advanceTimersByTimeAsync(5_000)
      expect(spawn).toHaveBeenCalledTimes(3)

      children[2].child.stdout.write(readyLine())
      await vi.advanceTimersByTimeAsync(120_000)
      children[2].child.emit('exit', 1)
      await vi.advanceTimersByTimeAsync(1_000)
      expect(spawn).toHaveBeenCalledTimes(4)
    })

    it('kills a core that is up but fails /health, then restarts', async () => {
      const children: FakeChild[] = []
      const spawn = vi.fn().mockImplementation(() => {
        const fake = fakeChild()
        children.push(fake)
        return fake.process
      })
      createSupervisor({
        exePath: 'core.exe',
        logsDir: 'logs',
        onState: () => undefined,
        log: { info: vi.fn(), warn: vi.fn() },
        spawn,
        fetch: vi.fn().mockResolvedValue({ ok: false, status: 500 })
      }).start()
      children[0].child.stdout.write(readyLine())
      await vi.advanceTimersByTimeAsync(1_000)
      expect(children[0].child.kill).toHaveBeenCalled()
      expect(spawn).toHaveBeenCalledTimes(2)
    })
  })

  describe('stop', () => {
    it('posts /shutdown with the token, resolves when core exits, and does not restart', async () => {
      const { child, spawn, fetch, supervisor } = setUp()
      child.stdout.write(readyLine())
      await vi.advanceTimersByTimeAsync(0)

      const stopped = vi.fn()
      void supervisor.stop().then(stopped)
      const token = (spawn.mock.calls[0][1] as NodeJS.ProcessEnv)['OPENVATRA_CORE_TOKEN']
      expect(fetch).toHaveBeenLastCalledWith('http://127.0.0.1:53121/shutdown', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` }
      })
      await vi.advanceTimersByTimeAsync(0)
      expect(stopped).not.toHaveBeenCalled()

      child.emit('exit', 0)
      await vi.advanceTimersByTimeAsync(10_000)
      expect(stopped).toHaveBeenCalled()
      expect(child.kill).not.toHaveBeenCalled()
      expect(spawn).toHaveBeenCalledTimes(1)
    })

    it('kills core if it has not exited after 8 s', async () => {
      const { child, supervisor } = setUp()
      child.stdout.write(readyLine())
      await vi.advanceTimersByTimeAsync(0)

      const stopped = vi.fn()
      void supervisor.stop().then(stopped)
      await vi.advanceTimersByTimeAsync(7_999)
      expect(child.kill).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1)
      expect(child.kill).toHaveBeenCalled()
      expect(stopped).toHaveBeenCalled()
    })

    it('kills core at once when /shutdown cannot be reached', async () => {
      const { child, supervisor } = setUp(
        vi.fn().mockResolvedValueOnce({ ok: true, status: 200 }).mockRejectedValue(new Error('refused'))
      )
      child.stdout.write(readyLine())
      await vi.advanceTimersByTimeAsync(0)
      void supervisor.stop()
      await vi.advanceTimersByTimeAsync(0)
      expect(child.kill).toHaveBeenCalled()
    })

    it('cancels a pending restart', async () => {
      const { child, spawn, supervisor } = setUp()
      child.emit('exit', 1)
      await supervisor.stop()
      await vi.advanceTimersByTimeAsync(60_000)
      expect(spawn).toHaveBeenCalledTimes(1)
    })
  })

  describe('restart', () => {
    function setUpRestartable(): ReturnType<typeof setUp> & { children: FakeChild[] } {
      const children: FakeChild[] = []
      const spawn = vi.fn().mockImplementation(() => {
        const fake = fakeChild()
        children.push(fake)
        return fake.process
      })
      const states: CoreState[] = []
      const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 200 })
      const supervisor = createSupervisor({
        exePath: 'core.exe',
        logsDir: 'logs',
        onState: (state) => states.push(state),
        log: { info: vi.fn(), warn: vi.fn() },
        spawn,
        fetch: fetchImpl
      })
      supervisor.start()
      return { ...children[0], children, states, spawn, supervisor, fetch: fetchImpl }
    }

    it('shuts the old core down, then starts a new one without counting it as a crash', async () => {
      const { children, states, spawn, supervisor } = setUpRestartable()
      children[0].child.stdout.write(readyLine())
      await vi.advanceTimersByTimeAsync(0)

      const restarted = vi.fn()
      void supervisor.restart().then(restarted)
      await vi.advanceTimersByTimeAsync(0)
      expect(spawn).toHaveBeenCalledTimes(1) // waits for the old one to be gone

      children[0].child.emit('exit', 0)
      await vi.advanceTimersByTimeAsync(0)
      expect(restarted).toHaveBeenCalled()
      expect(spawn).toHaveBeenCalledTimes(2)
      expect(states.map((state) => state.status)).not.toContain('problem')
      expect(states.at(-1)).toEqual({ status: 'starting' })
    })

    it('starts over after core gave up, forgetting the old crashes', async () => {
      const { children, states, spawn, supervisor } = setUpRestartable()
      children[0].child.emit('exit', 1)
      await vi.advanceTimersByTimeAsync(1_000)
      children[1].child.emit('exit', 1)
      await vi.advanceTimersByTimeAsync(5_000)
      children[2].child.emit('exit', 1)
      expect(states.at(-1)).toMatchObject({ status: 'problem' })
      expect(spawn).toHaveBeenCalledTimes(3)

      await supervisor.restart()
      expect(spawn).toHaveBeenCalledTimes(4)
      children[3].child.emit('exit', 1) // first crash again, so it restarts after 1 s
      await vi.advanceTimersByTimeAsync(1_000)
      expect(spawn).toHaveBeenCalledTimes(5)
    })

    it('ignores a second click while the first restart is in progress', async () => {
      const { children, spawn, supervisor } = setUpRestartable()
      children[0].child.stdout.write(readyLine())
      await vi.advanceTimersByTimeAsync(0)

      void supervisor.restart()
      void supervisor.restart()
      children[0].child.emit('exit', 0)
      await vi.advanceTimersByTimeAsync(0)
      expect(spawn).toHaveBeenCalledTimes(2)
    })

    it('does nothing once the app is stopping', async () => {
      const { child, spawn, supervisor } = setUp()
      void supervisor.stop()
      child.emit('exit', 0)
      await supervisor.restart()
      expect(spawn).toHaveBeenCalledTimes(1)
    })
  })
})

describe('core supervisor: onReady, post and request', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  function start(fetchImpl: typeof fetch): FakeChild & {
    onReady: ReturnType<typeof vi.fn>
    spawn: ReturnType<typeof vi.fn>
    supervisor: Supervisor
  } {
    const fake = fakeChild()
    const onReady = vi.fn()
    const spawn = vi.fn().mockReturnValue(fake.process)
    const supervisor = createSupervisor({
      exePath: 'core.exe',
      logsDir: 'logs',
      onState: () => {},
      onReady,
      log: { info: vi.fn(), warn: vi.fn() },
      spawn,
      fetch: fetchImpl
    })
    supervisor.start()
    return { ...fake, onReady, spawn, supervisor }
  }

  it('calls onReady once core is healthy, not before', async () => {
    const { child, onReady } = start(vi.fn().mockResolvedValue({ ok: true, status: 200 }))
    expect(onReady).not.toHaveBeenCalled()
    child.stdout.write(readyLine())
    await vi.advanceTimersByTimeAsync(0)
    expect(onReady).toHaveBeenCalledTimes(1)
  })

  it('posts JSON with the token, and rejects on an error status', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 })
    const { child, spawn, supervisor } = start(fetchMock)
    child.stdout.write(readyLine(53121))
    await vi.advanceTimersByTimeAsync(0)

    await supervisor.post('/api/config', { modelsDir: 'x' })

    const token = (spawn.mock.calls[0][1] as NodeJS.ProcessEnv)['OPENVATRA_CORE_TOKEN']
    const [url, init] = fetchMock.mock.lastCall as [string, RequestInit]
    expect(url).toBe('http://127.0.0.1:53121/api/config')
    expect(init).toMatchObject({ method: 'POST', body: '{"modelsDir":"x"}' })
    expect(Object.fromEntries(new Headers(init.headers))).toEqual({
      authorization: `Bearer ${token}`,
      'content-type': 'application/json'
    })

    fetchMock.mockResolvedValueOnce({ ok: false, status: 400 })
    await expect(supervisor.post('/api/config', {})).rejects.toThrow('HTTP 400')
  })

  it('rejects a post while core is not ready', async () => {
    const { supervisor } = start(vi.fn())
    await expect(supervisor.post('/api/config', {})).rejects.toThrow('not ready')
  })

  it('sends any request with the token and hands back the response, whatever its status', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 })
    const { child, spawn, supervisor } = start(fetchMock)
    child.stdout.write(readyLine(53121))
    await vi.advanceTimersByTimeAsync(0)
    const notFound = { ok: false, status: 404 }
    fetchMock.mockResolvedValueOnce(notFound)

    expect(await supervisor.request('/api/state')).toBe(notFound)

    const token = (spawn.mock.calls[0][1] as NodeJS.ProcessEnv)['OPENVATRA_CORE_TOKEN']
    const [url, init] = fetchMock.mock.lastCall as [string, RequestInit]
    expect(url).toBe('http://127.0.0.1:53121/api/state')
    expect(new Headers(init.headers).get('Authorization')).toBe(`Bearer ${token}`)
  })
})
