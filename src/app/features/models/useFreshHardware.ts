import { useEffect, useRef, useState } from 'react'
import { selectConnection } from '@app/core/connectionSlice'
import { useRefreshHardwareMutation } from '@app/core/generated'
import { useAppSelector } from '@app/store/hooks'
import { useModels } from './useModels'

const settleMs = 1000
const minGapMs = 5000

/**
 * Asks core to measure the hardware on mount, and again 1 s after any model turns ready or stopped, at most once
 * every 5 s: the card's free memory is only true right after a model has loaded or let go.
 * `fresh` turns true once the mount's refresh has answered (success or error), and stays true.
 */
export function useFreshHardware(): { fresh: boolean } {
  const [refresh] = useRefreshHardwareMutation()
  const [fresh, setFresh] = useState(false)
  const connected = useAppSelector(selectConnection) !== null
  const models = useModels()
  const lastAt = useRef(0)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const states = useRef<Map<string, string> | null>(null)

  // Without a connection there is nobody to ask; the first one that arrives counts as the mount.
  useEffect(() => {
    if (!connected) return
    lastAt.current = Date.now()
    void refresh().then(() => setFresh(true))
  }, [connected, refresh])

  useEffect(() => () => clearTimeout(timer.current), [])

  useEffect(() => {
    const before = states.current
    states.current = new Map(models.map((model) => [model.id, model.state]))
    if (!before || timer.current !== undefined) return
    const settled = models.some((model) => {
      const was = before.get(model.id)
      return (
        was !== undefined && was !== model.state && (model.state === 'ready' || model.state === 'stopped')
      )
    })
    if (!settled) return
    const wait = Math.max(settleMs, lastAt.current + minGapMs - Date.now())
    timer.current = setTimeout(() => {
      timer.current = undefined
      lastAt.current = Date.now()
      void refresh()
    }, wait)
  }, [models, refresh])

  return { fresh }
}
