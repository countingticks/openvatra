import { useCallback } from 'react'
import { defaultCoreModels, updateModels, type ModelsChange } from '../core/modelSettings'
import { useGetConfigModelsQuery, type Models, type ModelsEffective } from '../core/generated'
import { useAppDispatch } from '../store/hooks'

export interface ModelSettings {
  /** core's value; defaultCoreModels until core has answered once (decision 36). */
  value: Models
  /** The paths core really uses; null until core has answered. */
  effective: ModelsEffective | null
  update(change: ModelsChange): Promise<void>
}

/**
 * core's models section and the one way to change it. The query is never skipped, so the last answer stays on
 * screen while core restarts.
 */
export function useModelSettings(): ModelSettings {
  const dispatch = useAppDispatch()
  const { data } = useGetConfigModelsQuery()
  const update = useCallback((change: ModelsChange) => dispatch(updateModels(change)), [dispatch])
  return { value: data?.value ?? defaultCoreModels, effective: data?.effective ?? null, update }
}
