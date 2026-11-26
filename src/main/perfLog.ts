import { installPerfProbe, type PerfSnapshot } from '../shared/perfProbe'

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

/** The window's page, as main sees it; index.ts adapts webContents to it. */
export interface PerfPage {
  run(code: string): Promise<unknown>
  onLoad(listener: () => void): void
  isDestroyed(): boolean
}

export interface PerfLogOptions {
  env: Record<string, string | undefined>
  page: PerfPage
  appMetrics: () => { type: string; cpu: { percentCPUUsage: number } }[]
  log: { info: (message: string) => void; warn: (message: string) => void }
}

const intervalMs = 30_000
const readCode =
  '(() => { const p = window.__perf; if (!p) return null; const s = p.snapshot(); p.reset(); return s })()'

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isSnapshot(value: unknown): value is PerfSnapshot {
  if (typeof value !== 'object' || value === null) return false
  const frames = (value as { frames?: { count?: unknown } }).frames
  return typeof frames?.count === 'number'
}

/** Returns stop(): clears the timer. A no-op when the variable is not set. */
export function startPerfLog(options: PerfLogOptions): () => void {
  const { env, page, appMetrics, log } = options
  if (env.OPENVATRA_PERF !== '1') return () => {}

  log.info('perf: logging on, a summary every 30 s')

  const injectCode = `(${installPerfProbe.toString()})()`
  page.onLoad(() => {
    page.run(injectCode).catch((error: unknown) => {
      log.warn(`perf: probe not installed: ${messageOf(error)}`)
    })
  })

  let reading = false
  let failing = false
  const timer = setInterval(() => {
    if (page.isDestroyed()) {
      clearInterval(timer)
      return
    }
    if (reading) return
    reading = true
    page
      .run(readCode)
      .then((result) => {
        failing = false
        const metrics = appMetrics()
        if (!isSnapshot(result) || result.frames.count === 0) return
        log.info(formatPerfLine(result, cpuByType(metrics)))
      })
      .catch((error: unknown) => {
        // appMetrics still resets Electron's CPU window
        appMetrics()
        if (failing) return
        failing = true
        log.warn(`perf: snapshot failed: ${messageOf(error)}`)
      })
      .finally(() => {
        reading = false
      })
  }, intervalMs)

  return () => clearInterval(timer)
}
