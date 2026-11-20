import { QueryStatus } from '@reduxjs/toolkit/query'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { registerConfigSync } from '@app/core/configSync'
import { connectionChanged } from '@app/core/connectionSlice'
import { coreApi } from '@app/core/coreApi'
import { coreEvent } from '@app/core/events'
import type { Event } from '@app/core/generated'
import { createAppStore, type AppStore } from '@app/store/store'
import { fakePlatform } from '../../fakePlatform'
import { createFakeCoreHttp } from '../../fakeCoreHttp'

const llamacpp = { embeddingModel: null, idleUnloadMinutes: null, modelsDir: null, options: {} }

const configChanged = (section: string, rev: number): Event => ({
  seq: 5,
  time: 1,
  stream: 'system',
  type: 'config.changed',
  v: 1,
  data: { section, rev }
})

/** A store connected to a fake core, with getConfigProviderLlamacpp (rev 3) cached and subscribed. */
async function storeWithConfig(): Promise<{ store: AppStore; configFetches(): number }> {
  const http = createFakeCoreHttp()
  vi.stubGlobal('fetch', http.fetch)
  http.answer('/api/config/provider.llamacpp', { rev: 3, value: llamacpp })
  const { store, startListening } = createAppStore({ platform: fakePlatform().platform })
  registerConfigSync(startListening)
  store.dispatch(connectionChanged({ baseUrl: 'http://127.0.0.1:53121', token: 'a'.repeat(64) }))
  await store.dispatch(coreApi.endpoints.getConfigProviderLlamacpp.initiate())
  const configFetches = (): number =>
    http.requests.filter((request) => request.url.endsWith('/api/config/provider.llamacpp')).length
  return { store, configFetches }
}

const fetchingConfig = (store: AppStore): boolean =>
  coreApi.endpoints.getConfigProviderLlamacpp.select()(store.getState()).status === QueryStatus.pending

afterEach(() => {
  vi.restoreAllMocks()
})

describe('registerConfigSync', () => {
  it('does not refetch provider.llamacpp at the cached rev, and does at a newer one', async () => {
    const { store, configFetches } = await storeWithConfig()

    store.dispatch(coreEvent(configChanged('provider.llamacpp', 3)))
    expect(fetchingConfig(store)).toBe(false)

    store.dispatch(coreEvent(configChanged('provider.llamacpp', 4)))
    expect(fetchingConfig(store)).toBe(true)
    await vi.waitFor(() => expect(configFetches()).toBe(2))
  })

  it('invalidates config for a section with no endpoint of its own', async () => {
    const { store, configFetches } = await storeWithConfig()

    store.dispatch(coreEvent(configChanged('chat', 1)))

    expect(fetchingConfig(store)).toBe(true)
    await vi.waitFor(() => expect(configFetches()).toBe(2))
  })
})
