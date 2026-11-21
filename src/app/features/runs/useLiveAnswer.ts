import { useCallback, useSyncExternalStore } from 'react'
import { useStore } from 'react-redux'
import type { RootState } from '@app/store/store'
import { selectLiveAnswer } from './liveSlice'
import type { LiveAnswer } from './runView'

/** The live answer of a run, rendered at most once per animation frame however many deltas arrive in it. */
export function useLiveAnswer(runId: string | undefined): LiveAnswer | undefined {
  const store = useStore<RootState>()
  const read = useCallback(
    (): LiveAnswer | undefined =>
      runId === undefined ? undefined : selectLiveAnswer(store.getState(), runId),
    [store, runId]
  )

  const subscribe = useCallback(
    (onChange: () => void) => {
      let frame: number | null = null
      const unsubscribe = store.subscribe(() => {
        if (read() === undefined) {
          // The answer completed and the transcript holds it now: drop the live copy at once, not a frame late.
          if (frame !== null) cancelAnimationFrame(frame)
          frame = null
          onChange()
          return
        }
        frame ??= requestAnimationFrame(() => {
          frame = null
          onChange()
        })
      })
      return () => {
        unsubscribe()
        if (frame !== null) cancelAnimationFrame(frame)
      }
    },
    [store, read]
  )

  return useSyncExternalStore(subscribe, read)
}
