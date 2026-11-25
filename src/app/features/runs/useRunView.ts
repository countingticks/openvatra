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
  const skip = chatId === undefined || chatId === ''
  const { currentData: data, error, isFetching } = useGetTranscriptQuery({ id: chatId ?? '' }, { skip })
  const view = useMemo(() => (data === undefined ? null : runView(data)), [data])
  const context = data?.context ?? null

  // currentData, not data: while another chat's first fetch is on its way, the previous chat's answer must not show.
  // A skipped query also keeps its last answer: without a chat, the one open before must not show.
  if (skip) return { view: null, context: null, status: 'idle' }
  if (data !== undefined) return { view, context, status: 'ready' }
  if (error !== undefined && 'status' in error && error.status === 404) {
    return { view: null, context: null, status: 'notFound' }
  }
  return { view: null, context: null, status: error !== undefined && !isFetching ? 'error' : 'loading' }
}
