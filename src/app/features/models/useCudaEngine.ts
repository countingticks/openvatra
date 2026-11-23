import { useGetEnginesQuery, type EnginesBody } from '@app/core/generated'
import { useEngineSettings } from './useEngineSettings'
import { useSetup } from './useSetup'
import type { DownloadItem } from '@app/core/types'

export interface CudaEngine {
  /** An NVIDIA card and no llama-server of the user's own: the only case where the faster engine is on offer. */
  offered: boolean
  status: EnginesBody['cuda']
  /** Models are running on it right now (build auto or cuda, installed for this app's tag, and no custom path). */
  inUse: boolean
  /** The download while it is queued, running, paused or failed; undefined otherwise. */
  item: DownloadItem | undefined
}

/**
 * What the "faster engine for NVIDIA" card and the Settings line show. core decides what actually runs; this only
 * asks it what is installed (the event stream asks again when the download finishes) and reads the queue.
 */
export function useCudaEngine(): CudaEngine {
  const { hardware, downloads } = useSetup()
  const { build, path } = useEngineSettings().value
  // The card is optional; without an answer it just stays hidden.
  const status = useGetEnginesQuery().data?.cuda ?? 'none'

  const item = downloads.find((candidate) => candidate.id === 'engine-cuda' && candidate.state !== 'done')
  const custom = path !== null
  return {
    offered: hardware?.gpu?.vendor === 'nvidia' && !custom,
    status,
    inUse: !custom && (build === 'auto' || build === 'cuda') && status === 'ready',
    item
  }
}
