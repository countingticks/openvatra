import { describe, expect, it } from 'vitest'
import { formatReport } from '../../perf/format'
import type { ScenarioResult } from '../../perf/result'

function result(
  overrides: Omit<Partial<ScenarioResult>, 'probe'> & { probe?: Partial<ScenarioResult['probe']> } = {}
): ScenarioResult {
  const { probe, ...rest } = overrides
  return {
    scenario: 'stream',
    durationS: 15,
    probe: {
      durationMs: 15000,
      frames: { count: 100, p50: 16.7, p95: 18.2, p99: 41, over33: 5, over100: 0 },
      loaf: { count: 3, blockingMs: 120, top: [] },
      longtasks: 0,
      ...probe
    },
    averages: { renderer: 41.4, gpuProcess: 12.6, browser: 1, cpu: 33.2, gpu3d: 20, compute: 0.4 },
    samples: [],
    streamEnded: false,
    gpuCompositing: 'enabled',
    ...rest
  }
}

describe('formatReport', () => {
  it('shows frames, the >33ms share, LoAF and loads in one row', () => {
    const text = formatReport([result()], [])
    expect(text).toMatch(
      /stream\s+\| 16\.7 \/ 18\.2 \/ 41\.0\s+\| 5\.0%\s+\| 3 \/ 120\s+\| 41\s+\| 13\s+\| 33\s+\| 20\s+\| 0/
    )
  })

  it('shows n/a for null GPU fields and for null averages', () => {
    const gpuNull = formatReport(
      [result({ averages: { renderer: 1, gpuProcess: 1, browser: 1, cpu: 1, gpu3d: null, compute: null } })],
      []
    )
    expect(gpuNull).toMatch(/\| 1\s+\| n\/a\s+\| n\/a/)
    expect(formatReport([result({ averages: null })], [])).toMatch(
      /\| n\/a\s+\| n\/a\s+\| n\/a\s+\| n\/a\s+\| n\/a/
    )
  })

  it('shows zero frames as 0.0 / 0.0 / 0.0 and 0.0%', () => {
    const text = formatReport(
      [result({ probe: { frames: { count: 0, p50: 0, p95: 0, p99: 0, over33: 0, over100: 0 } } })],
      []
    )
    expect(text).toContain('0.0 / 0.0 / 0.0')
    expect(text).toMatch(/\| 0\.0%/)
  })

  it.each([
    [
      'blocking over 10%',
      { loaf: { count: 9, blockingMs: 3000, top: [] } },
      'main thread busy (LoAF blocking 20% of time)'
    ],
    [
      'late frames with little blocking',
      { frames: { count: 100, p50: 16, p95: 40, p99: 60, over33: 10, over100: 0 } },
      'frames late with an idle main thread → compositor/GPU'
    ],
    ['neither', {}, 'smooth']
  ])('hints for %s', (_name, probe, expected) => {
    expect(formatReport([result({ probe })], [])).toContain(`hint (stream): ${expected}`)
  })

  it('appends the ended note for a stream scenario but not for idle', () => {
    const text = formatReport(
      [result({ streamEnded: true }), result({ scenario: 'idle', streamEnded: true })],
      []
    )
    expect(text).toContain('hint (stream): smooth; answer ended inside the window')
    expect(text).toContain('hint (idle): smooth\n')
  })

  it('lists top scripts in order, and no line for a result without them', () => {
    const top = [
      { source: 'a.js:render', ms: 90, count: 4 },
      { source: 'b.js:layout', ms: 30, count: 2 }
    ]
    const text = formatReport(
      [result({ probe: { loaf: { count: 6, blockingMs: 120, top } } }), result({ scenario: 'idle' })],
      []
    )
    expect(text).toContain('top scripts (stream): a.js:render 90 ms ×4 · b.js:layout 30 ms ×2')
    expect(text).not.toContain('top scripts (idle)')
  })

  it('lists skipped scenarios with their reason', () => {
    expect(formatReport([], [{ scenario: 'real', reason: 'needs --model <gguf path>' }])).toContain(
      'skipped real: needs --model <gguf path>'
    )
  })
})
