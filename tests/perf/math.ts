import type { Averages } from './result'

export interface CpuTimes {
  user: number
  nice: number
  sys: number
  idle: number
  irq: number
}

const round1 = (n: number): number => Math.round(n * 10) / 10

/** Busy share of all cores between two os.cpus() readings, 0–100, one decimal. */
export function cpuBusyPercent(before: CpuTimes[], after: CpuTimes[]): number {
  let busy = 0
  let total = 0
  for (let i = 0; i < Math.min(before.length, after.length); i++) {
    const idle = after[i].idle - before[i].idle
    const work =
      after[i].user -
      before[i].user +
      (after[i].nice - before[i].nice) +
      (after[i].sys - before[i].sys) +
      (after[i].irq - before[i].irq)
    busy += work
    total += work + idle
  }
  return total > 0 ? round1((busy / total) * 100) : 0
}

/** The quoted cells of one typeperf CSV line, or null when the line is not a CSV row. */
function csvCells(line: string): string[] | null {
  const trimmed = line.trim()
  if (!trimmed.startsWith('"')) return null
  return [...trimmed.matchAll(/"([^"]*)"/g)].map((m) => m[1])
}

/** typeperf CSV lines (header first) → per data row the summed engtype_3D and engtype_Compute columns, each capped at 100. */
export function parseTypeperf(lines: string[]): { gpu3d: number; compute: number }[] {
  const rows = lines.map(csvCells).filter((cells): cells is string[] => cells !== null)
  if (rows.length < 2) return []
  const [header, ...data] = rows
  const columns3d: number[] = []
  const columnsCompute: number[] = []
  header.forEach((name, index) => {
    if (name.includes('engtype_3D')) columns3d.push(index)
    else if (name.includes('engtype_Compute')) columnsCompute.push(index)
  })
  const sum = (cells: string[], columns: number[]): number => {
    let total = 0
    for (const index of columns) {
      const value = Number(cells[index])
      if (cells[index] !== undefined && cells[index].trim() !== '' && Number.isFinite(value)) total += value
    }
    return Math.min(100, round1(total))
  }
  return data.map((cells) => ({ gpu3d: sum(cells, columns3d), compute: sum(cells, columnsCompute) }))
}

/** Mean of each field over samples; a field that is null in any sample is null. Zero samples → all 0, GPU fields null. */
export function averageOf(samples: Averages[]): Averages {
  const mean = (pick: (s: Averages) => number): number =>
    samples.length ? round1(samples.reduce((acc, s) => acc + pick(s), 0) / samples.length) : 0
  const meanOrNull = (pick: (s: Averages) => number | null): number | null => {
    if (samples.length === 0 || samples.some((s) => pick(s) === null)) return null
    return mean((s) => pick(s) as number)
  }
  return {
    renderer: mean((s) => s.renderer),
    gpuProcess: mean((s) => s.gpuProcess),
    browser: mean((s) => s.browser),
    cpu: mean((s) => s.cpu),
    gpu3d: meanOrNull((s) => s.gpu3d),
    compute: meanOrNull((s) => s.compute)
  }
}

/** core's model id for a GGUF path: the file stem without .gguf (any case) and without a -NNNNN-of-NNNNN part. */
export function modelIdOf(path: string): string {
  const file = path.split(/[\\/]/).pop() ?? path
  return file.replace(/\.gguf$/i, '').replace(/-\d{5}-of-\d{5}$/, '')
}
