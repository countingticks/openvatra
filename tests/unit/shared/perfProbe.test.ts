import { afterEach, describe, expect, it, vi } from 'vitest'
import { installPerfProbe } from '../../../src/shared/perfProbe'

interface Browser {
  frame(ts: number): void
  setNow(ms: number): void
  emit(type: string, entries: unknown[]): void
}

function stubBrowser(supported: string[] = ['long-animation-frame', 'longtask']): Browser {
  let pending: FrameRequestCallback[] = []
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => pending.push(cb))
  let now = 0
  vi.spyOn(performance, 'now').mockImplementation(() => now)

  const observers = new Map<string, ((list: { getEntries: () => unknown[] }) => void)[]>()
  class FakeObserver {
    static supportedEntryTypes = supported
    constructor(private cb: (list: { getEntries: () => unknown[] }) => void) {}
    observe(options: { type: string }): void {
      observers.set(options.type, [...(observers.get(options.type) ?? []), this.cb])
    }
  }
  vi.stubGlobal('PerformanceObserver', FakeObserver)

  return {
    frame(ts: number) {
      const run = pending
      pending = []
      run.forEach((cb) => cb(ts))
    },
    setNow(ms: number) {
      now = ms
    },
    emit(type: string, entries: unknown[]) {
      observers.get(type)?.forEach((cb) => cb({ getEntries: () => entries }))
    }
  }
}

function framesOf(browser: Browser, intervals: number[]): void {
  let ts = 1000
  browser.frame(ts)
  for (const interval of intervals) browser.frame((ts += interval))
}

const loaf = (blockingDuration: number, scripts: object[] = []): object => ({
  entryType: 'long-animation-frame',
  duration: blockingDuration + 50,
  blockingDuration,
  scripts
})

afterEach(() => {
  delete window.__perf
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('installPerfProbe', () => {
  it('summarises frame intervals', () => {
    const browser = stubBrowser()
    installPerfProbe()
    framesOf(browser, [...Array(95).fill(16), ...Array(4).fill(40), 120])
    expect(window.__perf!.snapshot().frames).toEqual({
      count: 100,
      p50: 16,
      p95: 16,
      p99: 40,
      over33: 5,
      over100: 1
    })
  })

  it('gives a zero frames block before any interval', () => {
    const browser = stubBrowser()
    installPerfProbe()
    browser.frame(1000)
    expect(window.__perf!.snapshot().frames).toEqual({
      count: 0,
      p50: 0,
      p95: 0,
      p99: 0,
      over33: 0,
      over100: 0
    })
  })

  it('sums long-frame blocking time and groups scripts by file and function', () => {
    const browser = stubBrowser()
    installPerfProbe()
    const script = (name: string, ms: number, sourceURL = 'http://x/app.js'): object => ({
      sourceFunctionName: name,
      sourceURL,
      duration: ms
    })
    browser.emit('long-animation-frame', [
      loaf(60.4, [script('render', 30, 'http://x/app.js?v=2#h'), script('render', 20)]),
      loaf(40.4, [{ invoker: 'IMG#logo.onload', duration: 5 }, { duration: 1 }]),
      loaf(
        0,
        Array.from({ length: 10 }, (_, i) => script(`f${i}`, 100 + i))
      )
    ])
    const { loaf: result } = window.__perf!.snapshot()
    expect(result.count).toBe(3)
    expect(result.blockingMs).toBe(101)
    expect(result.top).toHaveLength(8)
    expect(result.top.map((t) => t.source)).toEqual(
      ['f9', 'f8', 'f7', 'f6', 'f5', 'f4', 'f3', 'f2'].map((n) => `app.js:${n}`)
    )
    const grouped = installAndGroup()
    expect(grouped).toContainEqual({ source: 'app.js:render', ms: 50, count: 2 })
    expect(grouped).toContainEqual({ source: 'IMG#logo.onload', ms: 5, count: 1 })
    expect(grouped).toContainEqual({ source: '(anonymous)', ms: 1, count: 1 })
  })

  it('counts long tasks and keeps loaf at zero when only longtask is supported', () => {
    const browser = stubBrowser(['longtask'])
    installPerfProbe()
    browser.emit('longtask', [{}, {}])
    browser.emit('longtask', [{}])
    const snap = window.__perf!.snapshot()
    expect(snap.longtasks).toBe(3)
    expect(snap.loaf).toEqual({ count: 0, blockingMs: 0, top: [] })
  })

  it('reset clears the data and restarts the duration', () => {
    const browser = stubBrowser()
    installPerfProbe()
    framesOf(browser, [16, 50])
    browser.emit('long-animation-frame', [loaf(80)])
    browser.emit('longtask', [{}])
    browser.setNow(2500)
    expect(window.__perf!.snapshot().durationMs).toBe(2500)
    window.__perf!.reset()
    browser.setNow(2700)
    expect(window.__perf!.snapshot()).toEqual({
      durationMs: 200,
      frames: { count: 0, p50: 0, p95: 0, p99: 0, over33: 0, over100: 0 },
      loaf: { count: 0, blockingMs: 0, top: [] },
      longtasks: 0
    })
    browser.frame(1100)
    expect(window.__perf!.snapshot().frames.count).toBe(1)
  })

  it('keeps the first probe when installed twice', () => {
    const browser = stubBrowser()
    installPerfProbe()
    const first = window.__perf
    framesOf(browser, [16, 16])
    installPerfProbe()
    expect(window.__perf).toBe(first)
    expect(window.__perf!.snapshot().frames.count).toBe(2)
  })
})

// The "top 8" cut hides small groups, so the grouping check reads a fresh probe with only a few labels.
function installAndGroup(): { source: string; ms: number; count: number }[] {
  delete window.__perf
  const browser = stubBrowser()
  installPerfProbe()
  browser.emit('long-animation-frame', [
    loaf(0, [
      { sourceFunctionName: 'render', sourceURL: 'http://x/app.js?v=2#h', duration: 30 },
      { sourceFunctionName: 'render', sourceURL: 'http://x/app.js', duration: 20 },
      { invoker: 'IMG#logo.onload', duration: 5 },
      { duration: 1 }
    ])
  ])
  return window.__perf!.snapshot().loaf.top
}
