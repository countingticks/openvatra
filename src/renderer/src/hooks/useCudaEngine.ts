import { useGetEnginesQuery, type EnginesBody } from '@renderer/core/generated'
import { useSetup } from '@renderer/hooks/useSetup'
import { useAppSelector } from '@renderer/store/hooks'
import { selectSettings } from '@renderer/store/settingsSlice'
import type { DownloadItem } from '../../../shared/setup'

export interface CudaEngine {
  /** An NVIDIA card and no llama-server of the user's own: the only case where the faster engine is on offer. */
  offered: boolean
  status: EnginesBody['cuda']
  /** Models are running on it right now (chosen, installed for this app's tag, and no custom path). */
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
  const { engine, llamaServerPath } = useAppSelector(selectSettings).models
  // The card is optional; without an answer it just stays hidden.
  const status = useGetEnginesQuery().data?.cuda ?? 'none'

  const item = downloads.find((candidate) => candidate.id === 'engine-cuda' && candidate.state !== 'done')
  const custom = llamaServerPath !== null
  return {
    offered: hardware?.gpu?.vendor === 'nvidia' && !custom,
    status,
    inUse: !custom && engine === 'cuda' && status === 'ready',
    item
  }
}
