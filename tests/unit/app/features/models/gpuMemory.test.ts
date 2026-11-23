import { describe, expect, it } from 'vitest'
import { gpuMemory } from '@app/features/models/gpuMemory'
import type { Gpu, ModelInfo } from '@app/core/types'

const gib = 1024 ** 3
const gpu = (freeGib: number): Gpu => ({
  name: 'Card',
  vendor: 'nvidia',
  totalBytes: 12 * gib,
  freeBytes: freeGib * gib
})

const model = (vramGib: number | null): ModelInfo => ({
  id: `m${vramGib}`,
  state: 'ready',
  busy: false,
  sizeBytes: 1,
  kind: 'chat',
  context: null,
  moe: false,
  name: 'M',
  quant: null,
  tags: [],
  memory: vramGib === null ? null : { vramBytes: vramGib * gib, ramBytes: 0 }
})

describe('gpuMemory', () => {
  it('sums the models that report memory and ignores the others', () => {
    expect(gpuMemory(gpu(5), [model(2), model(null), model(1)]).modelBytes).toBe(3 * gib)
  })

  it('takes other apps as what the models do not explain, and never below zero', () => {
    expect(gpuMemory(gpu(5), [model(2)])).toMatchObject({ otherBytes: 5 * gib, freeBytes: 5 * gib })
    expect(gpuMemory(gpu(10), [model(4)])).toMatchObject({
      modelBytes: 4 * gib,
      otherBytes: 0,
      freeBytes: 8 * gib
    })
  })

  it('caps the models at the total and never reports negative free memory', () => {
    expect(gpuMemory(gpu(0), [model(10), model(10)])).toEqual({
      totalBytes: 12 * gib,
      modelBytes: 12 * gib,
      otherBytes: 0,
      freeBytes: 0
    })
  })
})
