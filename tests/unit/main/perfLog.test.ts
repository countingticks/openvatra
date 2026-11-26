import { describe, expect, it } from 'vitest'
import type { PerfSnapshot } from '../../../src/shared/perfProbe'
import { cpuByType, formatPerfLine } from '../../../src/main/perfLog'

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
