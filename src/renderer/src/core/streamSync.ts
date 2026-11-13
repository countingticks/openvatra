// Maps core's events onto the RTK Query cache: retained values replace cached answers, config changes refetch.
import type { AppDispatch, RootState } from '../store/store'
import { allTags, coreApi } from './coreApi'
import type { DownloadsBody, Event } from './generated'

type CachedSelect = (arg: undefined) => (state: RootState) => { data?: unknown }

/** The rev of the cached getConfig<Section> answer, or null when there is no such endpoint or nothing cached. */
function cachedRev(section: string, state: RootState): number | null {
  const name = `getConfig${section.charAt(0).toUpperCase()}${section.slice(1)}`
  if (!Object.hasOwn(coreApi.endpoints, name)) return null
  const endpoint = coreApi.endpoints[name as keyof typeof coreApi.endpoints]
  // The name is only known at runtime, so the endpoint's own argument type can't be; config sections take none.
  const { data } = (endpoint.select as CachedSelect)(undefined)(state)
  if (typeof data !== 'object' || data === null) return null
  const { rev } = data as Record<string, unknown>
  return typeof rev === 'number' ? rev : null
}

const cudaDone = (body: DownloadsBody | undefined): boolean =>
  body?.items.some((item) => item.id === 'engine-cuda' && item.state === 'done') ?? false

export function applyEvent(event: Event, dispatch: AppDispatch, getState: () => RootState): void {
  switch (event.type) {
    case 'model.state':
      dispatch(coreApi.util.upsertQueryData('listModels', undefined, event.data))
      return
    case 'download.progress': {
      // A CUDA build that just finished changes what /api/engines reports; ask once, on the change.
      const before = coreApi.endpoints.listDownloads.select()(getState()).data
      const finished = cudaDone(event.data) && !cudaDone(before)
      dispatch(coreApi.util.upsertQueryData('listDownloads', undefined, event.data))
      if (finished) dispatch(coreApi.util.invalidateTags(['engines']))
      return
    }
    case 'config.changed': {
      // The window's own write already brought this rev (or a newer one) back; refetching would gain nothing.
      const rev = cachedRev(event.data.section, getState())
      if (rev !== null && rev >= event.data.rev) return
      dispatch(coreApi.util.invalidateTags(['config']))
      return
    }
  }
  // Types this window does not know yet are ignored, so core can add events without breaking older windows.
}

export function invalidateAll(dispatch: AppDispatch): void {
  dispatch(coreApi.util.invalidateTags([...allTags]))
}
