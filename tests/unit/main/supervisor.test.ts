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
      onState: (state) => states.push(state),
      log: { info: vi.fn(), warn: vi.fn() },
      spawn: () => {
        throw new Error('ENOENT')
      }
    }).start()
    expect(states.at(-1)).toMatchObject({ status: 'problem', reason: expect.stringContaining('ENOENT') })
  })
})
