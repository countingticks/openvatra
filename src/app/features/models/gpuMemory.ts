import type { Gpu, ModelInfo } from '@app/core/types'

export interface GpuMemory {
  totalBytes: number
  /** Sum of memory.vramBytes over the models that report memory, capped at totalBytes. */
  modelBytes: number
  /** totalBytes − freeBytes − modelBytes, never below 0. */
  otherBytes: number
  /** totalBytes − modelBytes − otherBytes, never below 0. */
  freeBytes: number
}

/** Splits the card's video memory into what loaded models hold, what other programs hold and what is free. */
export function gpuMemory(gpu: Gpu, models: readonly ModelInfo[]): GpuMemory {
  const { totalBytes } = gpu
  const reported = models.reduce((sum, model) => sum + (model.memory?.vramBytes ?? 0), 0)
  const modelBytes = Math.min(reported, totalBytes)
  const otherBytes = Math.max(0, totalBytes - gpu.freeBytes - modelBytes)
  return { totalBytes, modelBytes, otherBytes, freeBytes: Math.max(0, totalBytes - modelBytes - otherBytes) }
}
