import { spawn } from 'child_process'
import { cpus } from 'os'
import type { ElectronApplication } from '@playwright/test'
import { cpuBusyPercent, parseTypeperf, type CpuTimes } from './math'
import type { Averages } from './result'

export interface Sampler<T> {
  stop(): Promise<T[]>
}

const INTERVAL_MS = 1000

/** Calls `tick` every second until stop(); a tick that returns undefined adds no sample. */
function everySecond<T>(tick: () => Promise<T | undefined> | T | undefined): Sampler<T> {
  const samples: T[] = []
  let busy: Promise<void> = Promise.resolve()
  const timer = setInterval(() => {
    busy = busy.then(async () => {
      try {
        const sample = await tick()
        if (sample !== undefined) samples.push(sample)
      } catch {
        // a failed tick is skipped
      }
    })
  }, INTERVAL_MS)
  return {
    async stop(): Promise<T[]> {
      clearInterval(timer)
      await busy
      return samples
    }
  }
}

/** Electron's own view of each process type: % of one core, summed per type. */
export function sampleApp(
  app: ElectronApplication
): Sampler<Pick<Averages, 'renderer' | 'gpuProcess' | 'browser'>> {
  return everySecond(async () => {
    const metrics = await app.evaluate(({ app: electronApp }) =>
      electronApp.getAppMetrics().map((m) => ({ type: m.type, cpu: m.cpu.percentCPUUsage }))
    )
    const sum = (type: string): number =>
      Math.round(metrics.filter((m) => m.type === type).reduce((acc, m) => acc + m.cpu, 0) * 10) / 10
    return { renderer: sum('Tab'), gpuProcess: sum('GPU'), browser: sum('Browser') }
  })
}

/** Whole-machine CPU use from os.cpus(); the first tick only stores the baseline. */
export function sampleCpu(): Sampler<number> {
  let previous: CpuTimes[] = cpus().map((c) => c.times)
  return everySecond(() => {
    const current = cpus().map((c) => c.times)
    const value = cpuBusyPercent(previous, current)
    previous = current
    return value
  })
}

/** GPU engine use from typeperf; resolves [] when typeperf is unavailable or silent. */
export function sampleGpu(): Sampler<{ gpu3d: number; compute: number }> {
  const lines: string[] = []
  let buffer = ''
  let unavailable = false
  let gotRow = false
  let csvRows = 0 // the header counts as the first
  let stopped = false
  const child = spawn('typeperf', ['\\GPU Engine(*)\\Utilization Percentage', '-si', '1'], {
    stdio: ['ignore', 'pipe', 'ignore'],
    windowsHide: true
  })
  child.on('error', () => {
    unavailable = true
  })
  child.on('exit', () => {
    if (!stopped) unavailable = true
  })
  child.stdout.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8')
    const parts = buffer.split(/\r?\n/)
    buffer = parts.pop() ?? ''
    for (const part of parts) {
      lines.push(part)
      if (part.trim().startsWith('"') && ++csvRows > 1) gotRow = true
    }
  })
  // No data row within 5 s: typeperf is missing or has no GPU counters.
  const giveUp = setTimeout(() => {
    if (!gotRow) unavailable = true
  }, 5000)
  return {
    async stop(): Promise<{ gpu3d: number; compute: number }[]> {
      stopped = true
      clearTimeout(giveUp)
      child.kill()
      if (unavailable) return []
      return parseTypeperf(lines)
    }
  }
}
