import { createApi } from '@reduxjs/toolkit/query/react'
import type { BaseQueryFn, FetchArgs } from '@reduxjs/toolkit/query/react'

type CoreError = { status: 'CORE_UNAVAILABLE' }

const unavailable: BaseQueryFn<string | FetchArgs, unknown, CoreError> = async () => ({
  error: { status: 'CORE_UNAVAILABLE' }
})

// The base the generated endpoints are injected into. Slice 2 gives it the real base query.
export const emptyApi = createApi({
  reducerPath: 'core',
  baseQuery: unavailable,
  endpoints: () => ({})
})
