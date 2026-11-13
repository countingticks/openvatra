// The one way the generated endpoints reach core: the current connection's address and ui token, read at call
// time, and core's error body turned into one error shape.
import { fetchBaseQuery } from '@reduxjs/toolkit/query/react'
import type { BaseQueryFn, FetchArgs, FetchBaseQueryError } from '@reduxjs/toolkit/query/react'
import type { CoreConnection } from '../../../shared/core'
import { selectConnection } from './connectionSlice'

export interface CoreErrorBody {
  error: string
  message: string
  [extra: string]: unknown
}

export type CoreQueryError =
  | { status: 'CORE_UNAVAILABLE' }
  | { status: number; data: CoreErrorBody }
  | { status: 'FETCH_ERROR' | 'PARSING_ERROR' | 'TIMEOUT_ERROR'; error: string }

function isCoreErrorBody(value: unknown): value is CoreErrorBody {
  if (typeof value !== 'object' || value === null) return false
  const { error, message } = value as Record<string, unknown>
  return typeof error === 'string' && typeof message === 'string'
}

const httpError = (status: number, body: unknown): CoreQueryError => ({
  status,
  data: isCoreErrorBody(body) ? body : { error: 'unknown', message: `core answered HTTP ${status}` }
})

function toCoreError(error: FetchBaseQueryError): CoreQueryError {
  if (typeof error.status === 'number') return httpError(error.status, error.data)
  // A failed answer whose body is not JSON (a proxy's HTML page, say) is still an HTTP error, not a parse failure.
  if (error.status === 'PARSING_ERROR' && (error.originalStatus < 200 || error.originalStatus > 299)) {
    return httpError(error.originalStatus, null)
  }
  if (error.status === 'CUSTOM_ERROR') return { status: 'FETCH_ERROR', error: error.error }
  return { status: error.status, error: error.error }
}

const queryWith = (connection: CoreConnection): ReturnType<typeof fetchBaseQuery> =>
  fetchBaseQuery({
    baseUrl: connection.baseUrl,
    prepareHeaders: (headers) => {
      headers.set('Authorization', `Bearer ${connection.token}`)
      return headers
    },
    // Looked up on each call, so tests can stub fetch after this module has loaded.
    fetchFn: (...args) => globalThis.fetch(...args)
  })

export const coreBaseQuery: BaseQueryFn<string | FetchArgs, unknown, CoreQueryError> = async (
  args,
  api,
  extraOptions
) => {
  const connection = selectConnection(api.getState() as { coreConnection: CoreConnection | null })
  if (connection === null) return { error: { status: 'CORE_UNAVAILABLE' } }
  const result = await queryWith(connection)(args, api, extraOptions)
  if (result.error) return { error: toCoreError(result.error), meta: result.meta }
  return { data: result.data, meta: result.meta }
}
