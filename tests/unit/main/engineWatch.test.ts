// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { createEngineWatch } from '../../../src/main/engineWatch'
import type { DownloadItem } from '../../../src/shared/setup'

const engine = (state: DownloadItem['state']): DownloadItem[] => [
  { id: 'engine-cuda', state, bytes: 1, total: 1, speed: 0 }
]

describe('engine download watch', () => {
  it('fires once when the download finishes, not for later queue updates', () => {
    const finished = vi.fn()
    const watch = createEngineWatch(finished)
    watch([])
    watch(engine('downloading'))
    watch(engine('done'))
    watch(engine('done'))
    expect(finished).toHaveBeenCalledTimes(1)
  })

  it('ignores a download that was already finished when the app started', () => {
    const finished = vi.fn()
    const watch = createEngineWatch(finished)
    watch(engine('done'))
    watch(engine('done'))
    expect(finished).not.toHaveBeenCalled()
  })
})
