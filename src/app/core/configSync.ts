// Refetches a config section's cached answer when core says it changed.
import type { AppStartListening, RootState } from '@app/store/store'
import { coreApi } from './coreApi'
import { coreEvent } from './events'

type CachedSelect = (arg: undefined) => (state: RootState) => { data?: unknown }

/** The rev of the cached getConfig<Section> answer, or null when there is no such endpoint or nothing cached. */
function cachedRev(section: string, state: RootState): number | null {
  // core's operationId rule: each dot-separated part capitalised, joined (engine.llamaserver -> EngineLlamaserver).
  const title = section
    .split('.')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('')
  const name = `getConfig${title}`
  if (!Object.hasOwn(coreApi.endpoints, name)) return null
  const endpoint = coreApi.endpoints[name as keyof typeof coreApi.endpoints]
  // The name is only known at runtime, so the endpoint's own argument type can't be; config sections take none.
  const { data } = (endpoint.select as CachedSelect)(undefined)(state)
  if (typeof data !== 'object' || data === null) return null
  const { rev } = data as Record<string, unknown>
  return typeof rev === 'number' ? rev : null
}

export function registerConfigSync(startListening: AppStartListening): void {
  startListening({
    actionCreator: coreEvent,
    effect: (action, api) => {
      const event = action.payload
      if (event.type !== 'config.changed') return
      // The window's own write already brought this rev (or a newer one) back; refetching would gain nothing.
      const rev = cachedRev(event.data.section, api.getState())
      if (rev !== null && rev >= event.data.rev) return
      api.dispatch(coreApi.util.invalidateTags(['config']))
    }
  })
}
