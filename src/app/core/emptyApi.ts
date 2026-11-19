import { createApi } from '@reduxjs/toolkit/query/react'
import { coreBaseQuery } from './baseQuery'

// The base the generated endpoints are injected into; generated.ts adds the tag types.
export const emptyApi = createApi({
  reducerPath: 'core',
  baseQuery: coreBaseQuery,
  endpoints: () => ({})
})
