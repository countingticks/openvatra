// Notices the moment the CUDA download finishes, so main can start using it. It looks for the change (not "done"
// being present), because the queue keeps finished items: after the user goes back to the standard engine, a later
// queue update must not switch CUDA on again.
import type { DownloadItem } from '../shared/setup'

const engineId = 'engine-cuda'

export function createEngineWatch(onFinished: () => void): (queue: DownloadItem[]) => void {
  let wasDone = true // the first queue seen is history (a finished engine from an earlier run)
  let first = true
  return (queue) => {
    const done = queue.some((item) => item.id === engineId && item.state === 'done')
    if (!first && done && !wasDone) onFinished()
    first = false
    wasDone = done
  }
}
