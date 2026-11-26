import { describe, expect, it } from 'vitest'
import { averageOf, cpuBusyPercent, parseTypeperf, type CpuTimes } from '../../perf/math'
import type { Averages } from '../../perf/result'

const times = (busy: number, idle: number): CpuTimes => ({ user: busy, nice: 0, sys: 0, idle, irq: 0 })

describe('cpuBusyPercent', () => {
  it('gives 50 when half the elapsed time was idle', () => {
    expect(cpuBusyPercent([times(0, 0), times(0, 0)], [times(50, 50), times(50, 50)])).toBe(50)
  })

  it('gives 0, not NaN, for identical readings', () => {
    expect(cpuBusyPercent([times(10, 10)], [times(10, 10)])).toBe(0)
  })
})

const engine = (id: string, kind: string): string =>
  `"\\\\HOST\\GPU Engine(pid_${id}_luid_0x0_phys_0_eng_0_engtype_${kind})\\Utilization Percentage"`

describe('parseTypeperf', () => {
  const header = `"(PDH-CSV 4.0)",${engine('1', '3D')},${engine('2', '3D')},${engine('1', 'Compute')},${engine('3', 'Copy')}`

  it('sums several 3D and Compute engines per row and ignores other engines', () => {
    const rows = parseTypeperf([header, '"11/26/2026 10:00:00.000","10","5.5","2","99"'])
    expect(rows).toEqual([{ gpu3d: 15.5, compute: 2 }])
  })

  it('caps a sum over 100, counts an empty cell as 0 and skips status lines', () => {
    const rows = parseTypeperf([
      'Some status text',
      header,
      '',
      '"t","80","70","",""',
      '"t","","","x","1"',
      'The command completed successfully.'
    ])
    expect(rows).toEqual([
      { gpu3d: 100, compute: 0 },
      { gpu3d: 0, compute: 0 }
    ])
  })
})

describe('averageOf', () => {
  const sample = (renderer: number, gpu3d: number | null): Averages => ({
    renderer,
    gpuProcess: 2,
    browser: 1,
    cpu: 10,
    gpu3d,
    compute: gpu3d
  })

  it('gives per-field means', () => {
    expect(averageOf([sample(10, 4), sample(20, 6)])).toEqual({
      renderer: 15,
      gpuProcess: 2,
      browser: 1,
      cpu: 10,
      gpu3d: 5,
      compute: 5
    })
  })

  it('gives null GPU fields when any sample has null', () => {
    const average = averageOf([sample(10, 4), sample(20, null)])
    expect(average.gpu3d).toBeNull()
    expect(average.compute).toBeNull()
    expect(average.renderer).toBe(15)
  })

  it('gives zeros and null GPU fields for no samples', () => {
    expect(averageOf([])).toEqual({
      renderer: 0,
      gpuProcess: 0,
      browser: 0,
      cpu: 0,
      gpu3d: null,
      compute: null
    })
  })
})
