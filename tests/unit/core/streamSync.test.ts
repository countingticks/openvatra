import { QueryStatus } from '@reduxjs/toolkit/query'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { connectionChanged } from '@renderer/core/connectionSlice'
import { coreApi } from '@renderer/core/coreApi'
import type { Event } from '@renderer/core/generated'
import { applyEvent } from '@renderer/core/streamSync'
import { createAppStore, type AppStore } from '@renderer/store/store'
import { defaultSettings } from '../../../src/shared/settings'
import { createFakeCoreHttp, type FakeCoreHttp } from '../fakeCoreHttp'

const models = {
  embeddingModel: null,
  engine: 'vulkan',
  idleUnloadMinutes: null,
  llamaServerPath: null,
  modelsDir: null,
  options: {}
}

const configChanged = (section: string, rev: number): Event => ({
  seq: 5,
  time: 1,
  stream: 'system',
  type: 'config.changed',
  v: 1,
  data: { section, rev }
})

/** A store connected to a fake core, with getConfigModels (rev 3) cached and subscribed. */
async function storeWithConfig(): Promise<{ store: AppStore; http: FakeCoreHttp; configFetches(): number }> {
  const http = createFakeCoreHttp()
  vi.stubGlobal('fetch', http.fetch)
  http.answer('/api/config/models', { rev: 3, value: models })
  const store = createAppStore({
    settings: { update: vi.fn().mockResolvedValue(defaultSettings), onChange: () => () => {} }
  })
  store.dispatch(connectionChanged({ baseUrl: 'http://127.0.0.1:53121', token: 'a'.repeat(64) }))
  await store.dispatch(coreApi.endpoints.getConfigModels.initiate())
  const configFetches = (): number =>
    http.requests.filter((request) => request.url.endsWith('/api/config/models')).length
  return { store, http, configFetches }
}

const fetchingConfig = (store: AppStore): boolean =>
  coreApi.endpoints.getConfigModels.select()(store.getState()).status === QueryStatus.pending

afterEach(() => {
  vi.restoreAllMocks()
})

describe('applyEvent', () => {
  it('refetches getConfigModels for a rev above the cached one, not for the same rev', async () => {
    const { store, configFetches } = await storeWithConfig()

    applyEvent(configChanged('models', 3), store.dispatch, store.getState)
    expect(fetchingConfig(store)).toBe(false)

    applyEvent(configChanged('models', 4), store.dispatch, store.getState)
    expect(fetchingConfig(store)).toBe(true)
    await vi.waitFor(() => expect(configFetches()).toBe(2))
  })

  it('invalidates config for a section with no endpoint of its own', async () => {
    const { store, configFetches } = await storeWithConfig()

    applyEvent(configChanged('chat', 1), store.dispatch, store.getState)

    expect(fetchingConfig(store)).toBe(true)
    await vi.waitFor(() => expect(configFetches()).toBe(2))
  })

  it('changes nothing for an event type it does not know', async () => {
    const { store } = await storeWithConfig()
    const before = store.getState()
    const unknown = { time: 1, stream: 'system', type: 'run.started', v: 1, data: {} }

    applyEvent(unknown as unknown as Event, store.dispatch, store.getState)

    expect(store.getState()).toBe(before)
  })
})
