import { useEffect, useState } from 'react'
import type { ModelInfo } from '../../../shared/core'

/** Every model in the models folder with its state, live. Empty until main answers, and while core isn't ready. */
export function useModels(): ModelInfo[] {
  const [models, setModels] = useState<ModelInfo[] | null>(null)

  useEffect(() => {
    // Same order as useCoreState: subscribe first, so a change during the first request isn't lost.
    const unsubscribe = window.api.core.onModels(setModels)
    window.api.core
      .models()
      .then((initial) => setModels((current) => current ?? initial))
      .catch((error) => console.error('Could not read the model list', error))
    return unsubscribe
  }, [])

  return models ?? []
}
