import { afterEach, describe, expect, it, vi, type Mock } from 'vitest'
import type { PerfSnapshot } from '../../../src/shared/perfProbe'
import { cpuByType, formatPerfLine, startPerfLog, type PerfLogOptions } from '../../../src/main/perfLog'

function snapshot(overrides: Partial<PerfSnapshot> = {}): PerfSnapshot {
  return {
    durationMs: 30000,
    frames: { count: 1000, p50: 16.7, p95: 18.2, p99: 30, over33: 31, over100: 0 },
    loaf: {
      count: 12,
      blockingMs: 410,
      top: [{ source: 'Markdown.tsx:ReactMarkdown', ms: 310, count: 5 }]
    },
    longtasks: 0,
    ...overrides
  }
}

describe('formatPerfLine', () => {
  it('formats the spec example', () => {
    expect(formatPerfLine(snapshot(), { renderer: 38, gpu: 9 })).toBe(
      'perf: frames p95 18.2 ms, >33ms 3.1%, LoAF 12 (410 ms), top Markdown.tsx:ReactMarkdown 310 ms; cpu renderer 38% gpu 9%'
    )
  })

  it('leaves out the top part without top scripts', () => {
    const line = formatPerfLine(snapshot({ loaf: { count: 0, blockingMs: 0, top: [] } }), {
      renderer: 1,
      gpu: 1
    })
    expect(line).toBe('perf: frames p95 18.2 ms, >33ms 3.1%, LoAF 0 (0 ms); cpu renderer 1% gpu 1%')
  })

  it('prints one decimal for p95 and whole numbers for CPU', () => {
    const line = formatPerfLine(
      snapshot({ frames: { count: 10, p50: 16, p95: 18, p99: 18, over33: 0, over100: 0 } }),
      { renderer: 37.6, gpu: 8.4 }
    )
    expect(line).toContain('p95 18.0 ms')
    expect(line).toContain('cpu renderer 38% gpu 8%')
  })
})

describe('cpuByType', () => {
  it('sums renderers and GPU and ignores other types', () => {
    const cpu = (n: number): { percentCPUUsage: number } => ({ percentCPUUsage: n })
    expect(
      cpuByType([
        { type: 'Tab', cpu: cpu(10) },
        { type: 'Tab', cpu: cpu(5) },
        { type: 'GPU', cpu: cpu(7) },
        { type: 'Browser', cpu: cpu(50) },
        { type: 'Utility', cpu: cpu(20) }
      ])
    ).toEqual({ renderer: 15, gpu: 7 })
  })
})

function fakePage(): {
  page: PerfLogOptions['page']
  run: ReturnType<typeof vi.fn>
  load: () => void
  listeners: number
  destroy: () => void
} {
  const state = { listener: null as (() => void) | null, destroyed: false }
  const run = vi.fn<(code: string) => Promise<unknown>>().mockResolvedValue(null)
  return {
    run,
    page: {
      run,
      onLoad: (listener) => {
        state.listener = listener
      },
      isDestroyed: () => state.destroyed
    },
    load: () => state.listener?.(),
    get listeners() {
      return state.listener ? 1 : 0
    },
    destroy: () => {
      state.destroyed = true
    }
  }
}

function setup(env: Record<string, string | undefined> = { OPENVATRA_PERF: '1' }): {
  fake: ReturnType<typeof fakePage>
  log: { info: Mock; warn: Mock }
  appMetrics: Mock<PerfLogOptions['appMetrics']>
  stop: () => void
} {
  vi.useFakeTimers()
  const fake = fakePage()
  const log = { info: vi.fn(), warn: vi.fn() }
  const appMetrics = vi.fn(() => [
    { type: 'Tab', cpu: { percentCPUUsage: 38 } },
    { type: 'GPU', cpu: { percentCPUUsage: 9 } }
  ])
  const stop = startPerfLog({ env, page: fake.page, appMetrics, log })
  return { fake, log, appMetrics, stop }
}

const tick = (ms = 30_000): Promise<unknown> => vi.advanceTimersByTimeAsync(ms)

describe('startPerfLog', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    delete window.__perf
  })

  it.each([{}, { OPENVATRA_PERF: '0' }])('does nothing for env %j', async (env) => {
    const { fake, log, appMetrics } = setup(env)
    await tick(60_000)
    expect(fake.listeners).toBe(0)
    expect(fake.run).not.toHaveBeenCalled()
    expect(appMetrics).not.toHaveBeenCalled()
    expect(log.info).not.toHaveBeenCalled()
    expect(log.warn).not.toHaveBeenCalled()
  })

  it('logs the logging-on line once and nothing else before the first tick', async () => {
    const { fake, log } = setup()
    await tick(29_000)
    expect(log.info.mock.calls).toEqual([['perf: logging on, a summary every 30 s']])
    expect(fake.run).not.toHaveBeenCalled()
  })

  it('injects a probe that leaves window.__perf on the page', async () => {
    const { fake } = setup()
    vi.stubGlobal('requestAnimationFrame', () => 0)
    vi.stubGlobal(
      'PerformanceObserver',
      class {
        static supportedEntryTypes: string[] = []
      }
    )
    fake.load()
    const code = fake.run.mock.calls[0][0] as string
    new Function(code)()
    expect(typeof window.__perf?.snapshot).toBe('function')
    expect(typeof window.__perf?.reset).toBe('function')
  })

  it('warns once when the injection is rejected and keeps reading', async () => {
    const { fake, log } = setup()
    fake.run.mockRejectedValueOnce(new Error('no page'))
    fake.load()
    await tick(0)
    expect(log.warn.mock.calls).toEqual([['perf: probe not installed: no page']])
    await tick()
    expect(fake.run).toHaveBeenCalledTimes(2)
  })

  it('reads with an expression that snapshots, resets and returns the snapshot', async () => {
    const { fake } = setup()
    await tick()
    const code = fake.run.mock.calls[0][0] as string
    expect(new Function('return ' + code)()).toBeNull()

    const order: string[] = []
    const snap = snapshot()
    window.__perf = {
      snapshot: () => {
        order.push('snapshot')
        return snap
      },
      reset: () => {
        order.push('reset')
      }
    }
    expect(new Function('return ' + code)()).toBe(snap)
    expect(order).toEqual(['snapshot', 'reset'])
  })

  it('logs the formatted line with CPU from appMetrics after 30 s', async () => {
    const { fake, log, appMetrics } = setup()
    fake.run.mockResolvedValueOnce(snapshot())
    await tick()
    expect(appMetrics).toHaveBeenCalledTimes(1)
    expect(log.info).toHaveBeenLastCalledWith(formatPerfLine(snapshot(), { renderer: 38, gpu: 9 }))
  })

  it('logs no line for an empty window but still reads the metrics', async () => {
    const { fake, log, appMetrics } = setup()
    fake.run.mockResolvedValueOnce(
      snapshot({ frames: { count: 0, p50: 0, p95: 0, p99: 0, over33: 0, over100: 0 } })
    )
    await tick()
    expect(appMetrics).toHaveBeenCalledTimes(1)
    expect(log.info).toHaveBeenCalledTimes(1)
  })

  it('logs no line for a null result', async () => {
    const { fake, log } = setup()
    fake.run.mockResolvedValueOnce(null)
    await tick()
    expect(log.info).toHaveBeenCalledTimes(1)
  })

  it('warns once for repeated read failures and again after a success', async () => {
    const { fake, log } = setup()
    fake.run
      .mockRejectedValueOnce(new Error('a'))
      .mockRejectedValueOnce(new Error('b'))
      .mockResolvedValueOnce(null)
      .mockRejectedValueOnce(new Error('c'))
    await tick(120_000)
    expect(log.warn.mock.calls).toEqual([['perf: snapshot failed: a'], ['perf: snapshot failed: c']])
  })

  it('skips a tick while the previous read is pending', async () => {
    const { fake } = setup()
    fake.run.mockReturnValueOnce(new Promise(() => {}))
    await tick(60_000)
    expect(fake.run).toHaveBeenCalledTimes(1)
  })

  it('stops reading once the page is destroyed', async () => {
    const { fake } = setup()
    await tick()
    expect(fake.run).toHaveBeenCalledTimes(1)
    fake.destroy()
    await tick(90_000)
    expect(fake.run).toHaveBeenCalledTimes(1)
  })

  it('stops reading after stop(), and stop() twice is harmless', async () => {
    const { fake, stop } = setup()
    stop()
    stop()
    await tick(60_000)
    expect(fake.run).not.toHaveBeenCalled()
  })
})
