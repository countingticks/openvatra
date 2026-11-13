// The generated client as the app uses it. The event stream keeps models and downloads current, so their cached
// answers stay even when no component is looking at them.
import { addTagTypes, generatedApi } from './generated'

export const coreApi = generatedApi.enhanceEndpoints({
  endpoints: {
    listModels: { keepUnusedDataFor: Infinity },
    listDownloads: { keepUnusedDataFor: Infinity },
    // The answer already is the new entry, and the write queue puts it in the cache.
    putConfigModels: { invalidatesTags: [] }
  }
})

export const allTags: readonly (typeof addTagTypes)[number][] = addTagTypes
