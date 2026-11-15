import { useCallback, useMemo } from 'react'
import {
  defaultEngineSettings,
  defaultLlamacppSettings,
  toModelsView,
  updateModels,
  type ModelsChange,
  type ModelsView
} from '../core/modelSettings'
import { useGetConfigEngineLlamaserverQuery, useGetConfigProviderLlamacppQuery } from '../core/generated'
import { useAppDispatch } from '../store/hooks'

export interface ModelSettings {
  /** core's values; each section's defaults until it has answered once (decision 36). */
  value: ModelsView
  /** The paths core really uses; null until both sections have answered. */
  effective: { llamaServerPath: string; modelsDir: string } | null
  update(change: ModelsChange): Promise<void>
}

/**
 * core's two model sections and the one way to change them. The queries are never skipped, so the last answer
 * stays on screen while core restarts.
 */
export function useModelSettings(): ModelSettings {
  const dispatch = useAppDispatch()
  const { data: engine } = useGetConfigEngineLlamaserverQuery()
  const { data: llamacpp } = useGetConfigProviderLlamacppQuery()
  const update = useCallback((change: ModelsChange) => dispatch(updateModels(change)), [dispatch])
  // Memoised per answer, so a component depending on value or effective only reruns when core sent something new.
  const engineValue = engine?.value
  const llamacppValue = llamacpp?.value
  const value = useMemo(
    () => toModelsView(engineValue ?? defaultEngineSettings, llamacppValue ?? defaultLlamacppSettings),
    [engineValue, llamacppValue]
  )
  const enginePath = engine?.effective?.path
  const modelsDir = llamacpp?.effective?.modelsDir
  const effective = useMemo(
    () =>
      enginePath !== undefined && modelsDir !== undefined ? { llamaServerPath: enginePath, modelsDir } : null,
    [enginePath, modelsDir]
  )
  return { value, effective, update }
}
