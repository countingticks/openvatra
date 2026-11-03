import { useEffect, useState } from 'react'
import type { CoreState } from '../../../shared/core'

/** The models service's state, live. `null` until main has answered the first time. */
export function useCoreState(): CoreState | null {
  const [state, setState] = useState<CoreState | null>(null)

  useEffect(() => {
    // Subscribe before asking: an update that lands while getState is in flight is newer than its answer, so the
    // answer only fills in if nothing has arrived yet.
    const unsubscribe = window.api.core.onState(setState)
    window.api.core
      .getState()
      .then((initial) => setState((current) => current ?? initial))
      .catch((error) => console.error('Could not read the models service state', error))
    return unsubscribe
  }, [])

  return state
}
