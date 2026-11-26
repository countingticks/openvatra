export interface PerfSnapshot {
  durationMs: number
  frames: { count: number; p50: number; p95: number; p99: number; over33: number; over100: number }
  loaf: { count: number; blockingMs: number; top: { source: string; ms: number; count: number }[] }
  longtasks: number
}

export interface PerfProbe {
  snapshot(): PerfSnapshot
  reset(): void
}

declare global {
  interface Window {
    __perf?: PerfProbe
  }
}

// Local shapes: the DOM lib does not declare long-animation-frame entries.
interface LoafScript {
  sourceURL?: string
  sourceFunctionName?: string
  invoker?: string
  duration: number
}

interface LoafEntry {
  entryType: string
  duration: number
  blockingDuration: number
  scripts?: LoafScript[]
}

/**
 * Puts window.__perf on the page. Self-contained on purpose: the function is serialized into pages
 * (page.evaluate, executeJavaScript), so it may not reference anything outside its own body.
 */
export function installPerfProbe(): void {
  if (window.__perf) return

  let startedAt = performance.now()
  let lastFrame: number | null = null
  let intervals: number[] = []
  let loafCount = 0
  let blockingMs = 0
  let groups = new Map<string, { ms: number; count: number }>()
  let longtasks = 0

  const tick = (ts: number): void => {
    if (lastFrame !== null) intervals.push(ts - lastFrame)
    lastFrame = ts
    requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)

  const addLoaf = (entry: LoafEntry): void => {
    loafCount++
    blockingMs += entry.blockingDuration
    for (const script of entry.scripts ?? []) {
      const name = script.sourceFunctionName || script.invoker || '(anonymous)'
      const file = (script.sourceURL ?? '').split(/[?#]/)[0].split('/').pop() ?? ''
      const label = file ? `${file}:${name}` : name
      const group = groups.get(label) ?? { ms: 0, count: 0 }
      group.ms += script.duration
      group.count++
      groups.set(label, group)
    }
  }

  const supported = PerformanceObserver.supportedEntryTypes ?? []
  const observe = (type: string, onEntries: (entries: PerformanceEntryList) => void): void => {
    if (!supported.includes(type)) return
    try {
      new PerformanceObserver((list): void => onEntries(list.getEntries())).observe({ type, buffered: true })
    } catch {
      // a type the browser lists but refuses stays at 0
    }
  }
  observe('long-animation-frame', (entries) => {
    for (const entry of entries) addLoaf(entry as unknown as LoafEntry)
  })
  observe('longtask', (entries) => {
    longtasks += entries.length
  })

  const round1 = (n: number): number => Math.round(n * 10) / 10

  window.__perf = {
    snapshot(): PerfSnapshot {
      const sorted = [...intervals].sort((a, b) => a - b)
      const rank = (p: number): number =>
        sorted.length ? round1(sorted[Math.ceil((p / 100) * sorted.length) - 1]) : 0
      const top = [...groups.entries()]
        .map(([source, g]) => ({ source, ms: Math.round(g.ms), count: g.count }))
        .sort((a, b) => b.ms - a.ms || (a.source < b.source ? -1 : a.source > b.source ? 1 : 0))
        .slice(0, 8)
      return {
        durationMs: Math.round(performance.now() - startedAt),
        frames: {
          count: sorted.length,
          p50: rank(50),
          p95: rank(95),
          p99: rank(99),
          over33: sorted.filter((v) => v > 33).length,
          over100: sorted.filter((v) => v > 100).length
        },
        loaf: { count: loafCount, blockingMs: Math.round(blockingMs), top },
        longtasks
      }
    },
    reset(): void {
      intervals = []
      loafCount = 0
      blockingMs = 0
      groups = new Map()
      longtasks = 0
      startedAt = performance.now()
    }
  }
}
