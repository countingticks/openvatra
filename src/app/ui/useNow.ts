import { useSyncExternalStore } from 'react'

let value = Date.now()
let timer: ReturnType<typeof setInterval> | undefined
const listeners = new Set<() => void>()

function subscribe(listener: () => void): () => void {
  if (listeners.size === 0) {
    value = Date.now()
    timer = setInterval(() => {
      value = Date.now()
      listeners.forEach((l) => l())
    }, 60_000)
  }
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0) {
      clearInterval(timer)
      timer = undefined
    }
  }
}

function getSnapshot(): number {
  return value
}

/** Date.now(), re-read once a minute from one interval shared by every component using it. */
export function useNow(): number {
  return useSyncExternalStore(subscribe, getSnapshot)
}
