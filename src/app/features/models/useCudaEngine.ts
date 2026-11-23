import { useGetEnginesQuery, type EnginesBody } from '@app/core/generated'
import { useEngineSettings } from './useEngineSettings'
import { useSetup } from './useSetup'
import type { DownloadItem } from '@app/core/types'

export interface CudaEngine {
  status: EnginesBody['cuda']
  /** A llama-server.exe of the user's own is set (engine path not null). */
  custom: boolean
  /** Models run on CUDA now: not custom, build auto or cuda, status ready. */
  inUse: boolean
  /** The engine-cuda download while queued, downloading, verifying, paused or failed. */
  item: DownloadItem | undefined
  /** Whole percent of item (floor of bytes / total × 100; 0 when total is 0); null without an item. */
  progress: number | null
}

/**
 * What the GPU card shows about the faster engine. core decides what actually runs; this only asks it what is
 * installed (the event stream asks again when the download finishes) and reads the queue.
 */
export function useCudaEngine(): CudaEngine {
  const { downloads } = useSetup()
  const { build, path } = useEngineSettings().value
  // Without an answer the engine counts as not installed.
  const status = useGetEnginesQuery().data?.cuda ?? 'none'

  const item = downloads.find((candidate) => candidate.id === 'engine-cuda' && candidate.state !== 'done')
  const custom = path !== null
  return {
    status,
    custom,
    inUse: !custom && (build === 'auto' || build === 'cuda') && status === 'ready',
    item,
    progress: item ? (item.total > 0 ? Math.floor((item.bytes / item.total) * 100) : 0) : null
  }
}
