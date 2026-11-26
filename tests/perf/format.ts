import type { ScenarioResult } from './result'

const HEADER = [
  'scenario',
  'frames p50/p95/p99 ms',
  '>33ms',
  'LoAF n/blocking ms',
  'renderer%',
  'gpu-proc%',
  'cpu%',
  'gpu3d%',
  'compute%'
]

const load = (value: number | null | undefined): string => (value == null ? 'n/a' : String(Math.round(value)))

function row(r: ScenarioResult): string[] {
  const { frames, loaf } = r.probe
  const late = frames.count > 0 ? (frames.over33 / frames.count) * 100 : 0
  const a = r.averages
  return [
    r.scenario,
    [frames.p50, frames.p95, frames.p99].map((v) => v.toFixed(1)).join(' / '),
    `${late.toFixed(1)}%`,
    `${loaf.count} / ${loaf.blockingMs}`,
    load(a?.renderer),
    load(a?.gpuProcess),
    load(a?.cpu),
    load(a?.gpu3d),
    load(a?.compute)
  ]
}

function hint(r: ScenarioResult): string {
  const { probe } = r
  const blockingShare = probe.durationMs > 0 ? (probe.loaf.blockingMs / probe.durationMs) * 100 : 0
  let text = 'smooth'
  if (blockingShare > 10) text = `main thread busy (LoAF blocking ${Math.round(blockingShare)}% of time)`
  else if (probe.frames.p95 > 33) text = 'frames late with an idle main thread → compositor/GPU'
  if (r.scenario !== 'idle' && r.streamEnded) text += '; answer ended inside the window'
  return `hint (${r.scenario}): ${text}`
}

export function formatReport(
  results: ScenarioResult[],
  skipped: { scenario: string; reason: string }[]
): string {
  const rows = [HEADER, ...results.map(row)]
  const widths = HEADER.map((_, i) => Math.max(...rows.map((cells) => cells[i].length)))
  const table = rows.map((cells) =>
    cells
      .map((cell, i) => cell.padEnd(widths[i]))
      .join(' | ')
      .trimEnd()
  )
  const lines = [...table]
  for (const r of results) {
    if (r.probe.loaf.top.length === 0) continue
    const top = r.probe.loaf.top.map((t) => `${t.source} ${t.ms} ms ×${t.count}`).join(' · ')
    lines.push(`top scripts (${r.scenario}): ${top}`)
  }
  for (const r of results) lines.push(hint(r))
  for (const s of skipped) lines.push(`skipped ${s.scenario}: ${s.reason}`)
  lines.push(
    'renderer% gpu-proc% = % of one core (getAppMetrics); cpu% = whole machine; gpu3d%/compute% = typeperf GPU engines'
  )
  return lines.join('\n')
}
