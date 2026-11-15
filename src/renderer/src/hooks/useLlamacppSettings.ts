import { useCallback } from 'react'
import {
  defaultLlamacppSettings,
  updateLlamacpp,
  type LlamacppChange,
  type SectionSettings
} from '../core/modelSettings'
import { useGetConfigProviderLlamacppQuery } from '../core/generated'
import type { LlamaCppEffective, LlamaCppSettings } from '../core/generated'
import { useAppDispatch } from '../store/hooks'

/** provider.llamacpp and the one way to change it. The query is never skipped, so the last answer stays on screen. */
export function useLlamacppSettings(): SectionSettings<LlamaCppSettings, LlamaCppEffective, LlamacppChange> {
  const dispatch = useAppDispatch()
  const { data } = useGetConfigProviderLlamacppQuery()
  const update = useCallback((change: LlamacppChange) => dispatch(updateLlamacpp(change)), [dispatch])
  return { value: data?.value ?? defaultLlamacppSettings, effective: data?.effective ?? null, update }
}
