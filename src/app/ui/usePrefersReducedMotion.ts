// True when the user asked for less motion (Windows: Settings → Accessibility → Visual effects → Animation
// effects off). Follows the setting live.
import { useSyncExternalStore } from 'react'

const query = '(prefers-reduced-motion: reduce)'

function subscribe(onChange: () => void): () => void {
  const media = window.matchMedia?.(query)
  media?.addEventListener('change', onChange)
  return () => media?.removeEventListener('change', onChange)
}

// matchMedia can be missing (e.g. in jsdom); assume motion is fine then.
const getSnapshot = (): boolean => window.matchMedia?.(query).matches ?? false

export function usePrefersReducedMotion(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot)
}
