import { QueryStatus } from '@reduxjs/toolkit/query'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { connectionChanged } from '@app/core/connectionSlice'
import { coreApi } from '@app/core/coreApi'
import type { Event } from '@app/core/generated'
import { applyEvent } from '@app/core/streamSync'
import { createAppStore, type AppStore } from '@app/store/store'
import { fakePlatform } from '../../fakePlatform'
import { createFakeCoreHttp, type FakeCoreHttp } from '../../fakeCoreHttp'

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
async function storeWithConfig(): Promise<{ store: AppStore; http: FakeCoreHttp; configFetches(): number }> {
  const http = createFakeCoreHttp()
  vi.stubGlobal('fetch', http.fetch)
  http.answer('/api/config/provider.llamacpp', { rev: 3, value: llamacpp })
  const store = createAppStore({ platform: fakePlatform().platform }).store
  store.dispatch(connectionChanged({ baseUrl: 'http://127.0.0.1:53121', token: 'a'.repeat(64) }))
  await store.dispatch(coreApi.endpoints.getConfigProviderLlamacpp.initiate())
  const configFetches = (): number =>
    http.requests.filter((request) => request.url.endsWith('/api/config/provider.llamacpp')).length
  return { store, http, configFetches }
}

const downloadProgress = (items: { id: string; state: 'downloading' | 'done' }[]): Event => ({
  time: 1,
  stream: 'system',
  type: 'download.progress',
  v: 1,
  data: { items: items.map((item) => ({ ...item, bytes: 1, total: 1, speed: 0 })) }
})

/** A connected store with getEngines cached and subscribed, as the faster-engine card keeps it. */
async function storeWithEngines(): Promise<{ store: AppStore; engineFetches(): number }> {
  const { store, http } = await storeWithConfig()
  http.answer('/api/engines', { bundled: { tag: 'b12078' }, cuda: 'none' })
  await store.dispatch(coreApi.endpoints.getEngines.initiate())
  const engineFetches = (): number =>
    http.requests.filter((request) => request.url.endsWith('/api/engines')).length
  return { store, engineFetches }
}

/** Applies a download.progress event and waits until its items are cached (upsertQueryData settles a tick later). */
async function applied(store: AppStore, event: Event): Promise<void> {
  applyEvent(event, store.dispatch, store.getState)
  await vi.waitFor(() =>
    expect(coreApi.endpoints.listDownloads.select()(store.getState()).data).toEqual(event.data)
  )
}

const fetchingEngines = (store: AppStore): boolean =>
  coreApi.endpoints.getEngines.select()(store.getState()).status === QueryStatus.pending

const fetchingConfig = (store: AppStore): boolean =>
  coreApi.endpoints.getConfigProviderLlamacpp.select()(store.getState()).status === QueryStatus.pending

afterEach(() => {
  vi.restoreAllMocks()
})

describe('applyEvent', () => {
  it('does not refetch provider.llamacpp at the cached rev, and does at a newer one', async () => {
    const { store, configFetches } = await storeWithConfig()

    applyEvent(configChanged('provider.llamacpp', 3), store.dispatch, store.getState)
    expect(fetchingConfig(store)).toBe(false)

    applyEvent(configChanged('provider.llamacpp', 4), store.dispatch, store.getState)
    expect(fetchingConfig(store)).toBe(true)
    await vi.waitFor(() => expect(configFetches()).toBe(2))
  })

  it('invalidates config for a section with no endpoint of its own', async () => {
    const { store, configFetches } = await storeWithConfig()

    applyEvent(configChanged('chat', 1), store.dispatch, store.getState)

    expect(fetchingConfig(store)).toBe(true)
    await vi.waitFor(() => expect(configFetches()).toBe(2))
  })

  it('refetches getEngines once when engine-cuda turns done', async () => {
    const { store, engineFetches } = await storeWithEngines()
    await applied(store, downloadProgress([{ id: 'engine-cuda', state: 'downloading' }]))
    expect(fetchingEngines(store)).toBe(false)

    await applied(store, downloadProgress([{ id: 'engine-cuda', state: 'done' }]))
    await vi.waitFor(() => expect(engineFetches()).toBe(2))
    await vi.waitFor(() => expect(fetchingEngines(store)).toBe(false))

    await applied(store, downloadProgress([{ id: 'engine-cuda', state: 'done' }]))
    expect(fetchingEngines(store)).toBe(false)
    expect(engineFetches()).toBe(2)
  })

  it('does not refetch getEngines when another download turns done', async () => {
    const { store, engineFetches } = await storeWithEngines()
    await applied(store, downloadProgress([{ id: 'qwen3-8b', state: 'downloading' }]))

    await applied(store, downloadProgress([{ id: 'qwen3-8b', state: 'done' }]))

    expect(fetchingEngines(store)).toBe(false)
    expect(engineFetches()).toBe(1)
  })

  it('changes nothing for an event type it does not know', async () => {
    const { store } = await storeWithConfig()
    const before = store.getState()
    const unknown = { time: 1, stream: 'system', type: 'run.started', v: 1, data: {} }

    applyEvent(unknown as unknown as Event, store.dispatch, store.getState)

    expect(store.getState()).toBe(before)
  })
})
