import { useEffect, useState } from 'react'
import { nextLocalMidnight } from './chatGroups'

/** Date.now() at mount, replaced by the then-current time each time a local midnight passes. */
export function useLocalDay(): number {
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>
    const schedule = (from: number): void => {
      timer = setTimeout(
        () => {
          const next = Date.now()
          setNow(next)
          schedule(next)
        },
        nextLocalMidnight(from) - from
      )
    }
    schedule(Date.now())
    return () => clearTimeout(timer)
  }, [])

  return now
}
