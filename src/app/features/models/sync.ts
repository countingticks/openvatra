// Maps core's model and download events onto the RTK Query cache: retained values replace cached answers.
import type { DownloadsBody } from '@app/core/generated'
import { coreApi } from '@app/core/coreApi'
import { coreEvent } from '@app/core/events'
import type { AppStartListening } from '@app/store/store'

const cudaDone = (body: DownloadsBody | undefined): boolean =>
  body?.items.some((item) => item.id === 'engine-cuda' && item.state === 'done') ?? false

export function registerModels(startListening: AppStartListening): void {
  startListening({
    actionCreator: coreEvent,
    effect: (action, api) => {
      const event = action.payload
      switch (event.type) {
        case 'model.state':
          api.dispatch(coreApi.util.upsertQueryData('listModels', undefined, event.data))
          return
        case 'download.progress': {
          // A CUDA build that just finished changes what /api/engines reports; ask once, on the change.
          const before = coreApi.endpoints.listDownloads.select()(api.getState()).data
          const finished = cudaDone(event.data) && !cudaDone(before)
          api.dispatch(coreApi.util.upsertQueryData('listDownloads', undefined, event.data))
          if (finished) api.dispatch(coreApi.util.invalidateTags(['engines']))
          return
        }
      }
      // Other types are not this feature's.
    }
  })
}
