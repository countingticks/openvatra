import {
  useGetConfigEngineLlamaserverQuery,
  useGetConfigProviderLlamacppQuery,
  useGetEnginesQuery,
  useGetHardwareQuery
} from '@app/core/generated'
import { selectConnection } from '@app/core/connectionSlice'
import { useAppSelector } from '@app/store/hooks'

/**
 * False only while core is connected and has not yet answered everything Settings › Models shows a value from (an
 * error counts as an answer): the section would show defaults and then switch. Without a connection it is true, so
 * the section shows the service's state instead of waiting. The shell calls it from the start, so the answers
 * are usually in the cache before Settings first opens.
 */
export function useModelSettingsReady(): boolean {
  // CORE_UNAVAILABLE is the answer from before the connection, kept while the refetch is on its way.
  const answered = (query: { data?: unknown; error?: object }): boolean =>
    query.data !== undefined ||
    (query.error !== undefined && !('status' in query.error && query.error.status === 'CORE_UNAVAILABLE'))
  const engine = useGetConfigEngineLlamaserverQuery()
  const llamacpp = useGetConfigProviderLlamacppQuery()
  const engines = useGetEnginesQuery()
  const hardware = useGetHardwareQuery()
  const connected = useAppSelector(selectConnection) !== null
  return !connected || (answered(engine) && answered(llamacpp) && answered(engines) && answered(hardware))
}
