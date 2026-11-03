// Whether to hold still: the app's decision on <html data-motion> (Settings → Animations combined with Windows).
// Before the app has decided (or in a component rendered on its own, as in its unit tests) it falls back to what
// Windows asks for. Follows both live.
import { useSyncExternalStore } from 'react'
import { motionAttribute } from '@renderer/motion'

const windowsQuery = '(prefers-reduced-motion: reduce)'

function subscribe(onChange: () => void): () => void {
  const watcher = new MutationObserver(onChange)
  watcher.observe(document.documentElement, { attributes: true, attributeFilter: [motionAttribute] })
  const media = window.matchMedia?.(windowsQuery)
  media?.addEventListener('change', onChange)
  return () => {
    watcher.disconnect()
    media?.removeEventListener('change', onChange)
  }
}

function getSnapshot(): boolean {
  const decided = document.documentElement.getAttribute(motionAttribute)
  if (decided) return decided === 'reduce'
  return window.matchMedia?.(windowsQuery).matches ?? false
}

export function useReducedMotion(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot)
}
