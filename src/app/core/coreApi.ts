// The generated client as the app uses it. The event stream keeps models and downloads current, so their cached
// answers stay even when no component is looking at them.
import { addTagTypes, generatedApi } from './generated'

export const coreApi = generatedApi.enhanceEndpoints({
  endpoints: {
    listModels: { keepUnusedDataFor: Infinity },
    listDownloads: { keepUnusedDataFor: Infinity },
    // Hugging Face answers are asked for by the user and never refetched by the event stream's invalidateAll.
    searchHf: { providesTags: [] },
    listHfFiles: { providesTags: [] },
    // A removed model can be a catalog entry's file: the catalog's "installed" flag changes with it.
    removeModel: { invalidatesTags: ['models', 'catalog'] },
    // The answer already is the new entry, and the write queue puts it in the cache.
    putConfigEngineLlamaserver: { invalidatesTags: [] },
    putConfigProviderLlamacpp: { invalidatesTags: [] }
  }
})

export const allTags: readonly (typeof addTagTypes)[number][] = addTagTypes
