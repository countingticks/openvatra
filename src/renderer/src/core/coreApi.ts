// The generated client as the app uses it. The event stream keeps models and downloads current, so their cached
// answers stay even when no component is looking at them.
import { addTagTypes, generatedApi } from './generated'

export const coreApi = generatedApi.enhanceEndpoints({
  endpoints: {
    listModels: { keepUnusedDataFor: Infinity },
    listDownloads: { keepUnusedDataFor: Infinity }
  }
})

export const allTags: readonly (typeof addTagTypes)[number][] = addTagTypes
