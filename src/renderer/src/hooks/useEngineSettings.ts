import { useCallback } from 'react'
import {
  defaultEngineSettings,
  updateEngine,
  type EngineChange,
  type SectionSettings
} from '../core/modelSettings'
import { useGetConfigEngineLlamaserverQuery } from '@app/core/generated'
import type { LlamaServerEffective, LlamaServerSettings } from '@app/core/generated'
import { useAppDispatch } from '@app/store/hooks'

/** engine.llamaserver and the one way to change it. The query is never skipped, so the last answer stays on screen. */
export function useEngineSettings(): SectionSettings<
  LlamaServerSettings,
  LlamaServerEffective,
  EngineChange
> {
  const dispatch = useAppDispatch()
  const { data } = useGetConfigEngineLlamaserverQuery()
  const update = useCallback((change: EngineChange) => dispatch(updateEngine(change)), [dispatch])
  return { value: data?.value ?? defaultEngineSettings, effective: data?.effective ?? null, update }
}
