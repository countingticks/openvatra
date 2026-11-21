import { useMemo } from 'react'
import { useGetTranscriptQuery, type ContextUse } from '@app/core/generated'
import { runView, type RunView } from './runView'

export interface RunViewState {
  view: RunView | null
  context: ContextUse | null
  status: 'idle' | 'loading' | 'ready' | 'notFound' | 'error'
}

/** A chat's transcript in reading order, kept current by registerRuns; nothing while no chat is open. */
export function useRunView(chatId: string | undefined): RunViewState {
  const { data, error, isLoading, isUninitialized } = useGetTranscriptQuery(
    { id: chatId ?? '' },
    { skip: chatId === undefined || chatId === '' }
  )
  const view = useMemo(() => (data === undefined ? null : runView(data)), [data])
  const context = data?.context ?? null

  if (data !== undefined) return { view, context, status: 'ready' }
  if (isUninitialized) return { view: null, context: null, status: 'idle' }
  if (isLoading) return { view: null, context: null, status: 'loading' }
  if (error !== undefined && 'status' in error && error.status === 404) {
    return { view: null, context: null, status: 'notFound' }
  }
  return { view: null, context: null, status: error === undefined ? 'loading' : 'error' }
}
