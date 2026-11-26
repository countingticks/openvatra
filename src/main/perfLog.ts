import type { PerfSnapshot } from '../shared/perfProbe'

export interface PerfCpu {
  renderer: number
  gpu: number
}

// Electron calls renderer processes 'Tab'.
export function cpuByType(metrics: { type: string; cpu: { percentCPUUsage: number } }[]): PerfCpu {
  const sum = (type: string): number =>
    metrics.filter((m) => m.type === type).reduce((total, m) => total + m.cpu.percentCPUUsage, 0)
  return { renderer: sum('Tab'), gpu: sum('GPU') }
}

export function formatPerfLine(snapshot: PerfSnapshot, cpu: PerfCpu): string {
  const { frames, loaf } = snapshot
  const late = frames.count === 0 ? 0 : (frames.over33 / frames.count) * 100
  const top = loaf.top[0] ? `, top ${loaf.top[0].source} ${loaf.top[0].ms} ms` : ''
  return (
    `perf: frames p95 ${frames.p95.toFixed(1)} ms, >33ms ${late.toFixed(1)}%, ` +
    `LoAF ${loaf.count} (${loaf.blockingMs} ms)${top}; ` +
    `cpu renderer ${Math.round(cpu.renderer)}% gpu ${Math.round(cpu.gpu)}%`
  )
}
