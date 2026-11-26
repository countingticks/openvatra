import type { PerfSnapshot } from '../../src/shared/perfProbe'

export type ScenarioName =
  'idle' | 'stream' | 'stream-cpu' | 'stream-nogpu' | 'stream-still' | 'stream-long' | 'real' | 'real-nogpu'

export interface Averages {
  renderer: number // % of one core, Electron 'Tab' processes summed
  gpuProcess: number // % of one core, 'GPU' process
  browser: number // % of one core, 'Browser' process
  cpu: number // % of the whole machine, 0–100
  gpu3d: number | null // summed 3D engine use, null = typeperf unavailable
  compute: number | null // summed Compute engine use, null = typeperf unavailable
}

export interface ScenarioResult {
  scenario: ScenarioName
  durationS: number
  probe: PerfSnapshot
  averages: Averages | null // null until the samplers run
  samples: (Averages & { t: number })[] // one per second, t = seconds since the measured window began
  streamEnded: boolean // a "Copy answer" button was in the conversation when the window closed
  gpuCompositing: string // app.getGPUFeatureStatus().gpu_compositing
  tracePath?: string
}
