import { QueryStatus } from '@reduxjs/toolkit/query'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { connectionChanged } from '@app/core/connectionSlice'
import { coreApi } from '@app/core/coreApi'
import { coreEvent } from '@app/core/events'
import type { Event, Model } from '@app/core/generated'
import { registerModels } from '@app/features/models'
import { createAppStore, type AppStore } from '@app/store/store'
import { fakePlatform } from '../../../fakePlatform'
import { createFakeCoreHttp, type FakeCoreHttp } from '../../../fakeCoreHttp'

const model: Model = {
  id: 'qwen3-8b',
  state: 'ready',
  busy: false,
  kind: 'chat',
  sizeBytes: 5_000_000_000,
  context: null,
  moe: false,
  name: 'qwen3-8b',
  quant: null,
  tags: []
}

const downloadProgress = (items: { id: string; state: 'downloading' | 'done' }[]): Event => ({
  time: 1,
  stream: 'system',
  type: 'download.progress',
  v: 1,
  data: { items: items.map((item) => ({ ...item, bytes: 1, total: 1, speed: 0 })) }
})

/** A store connected to a fake core, with getEngines cached and subscribed, as the faster-engine card keeps it. */
async function storeWithEngines(): Promise<{ store: AppStore; http: FakeCoreHttp; engineFetches(): number }> {
  const http = createFakeCoreHttp()
  vi.stubGlobal('fetch', http.fetch)
  const { store, startListening } = createAppStore({ platform: fakePlatform().platform })
  registerModels(startListening)
  store.dispatch(connectionChanged({ baseUrl: 'http://127.0.0.1:53121', token: 'a'.repeat(64) }))
  http.answer('/api/engines', { bundled: { tag: 'b12078' }, cuda: 'none' })
  await store.dispatch(coreApi.endpoints.getEngines.initiate())
  const engineFetches = (): number =>
    http.requests.filter((request) => request.url.endsWith('/api/engines')).length
  return { store, http, engineFetches }
}

/** Dispatches a download.progress event and waits until its items are cached (upsertQueryData settles a tick later). */
async function applied(store: AppStore, event: Event): Promise<void> {
  store.dispatch(coreEvent(event))
  await vi.waitFor(() =>
    expect(coreApi.endpoints.listDownloads.select()(store.getState()).data).toEqual(event.data)
  )
}

const fetchingEngines = (store: AppStore): boolean =>
  coreApi.endpoints.getEngines.select()(store.getState()).status === QueryStatus.pending

afterEach(() => {
  vi.restoreAllMocks()
})

describe('registerModels', () => {
  it('model.state fills listModels', async () => {
    const { store } = await storeWithEngines()
    const event: Event = { time: 1, stream: 'system', type: 'model.state', v: 1, data: { models: [model] } }

    store.dispatch(coreEvent(event))

    await vi.waitFor(() =>
      expect(coreApi.endpoints.listModels.select()(store.getState()).data).toEqual({ models: [model] })
    )
  })

  it('download.progress fills listDownloads', async () => {
    const { store } = await storeWithEngines()

    await applied(store, downloadProgress([{ id: 'qwen3-8b', state: 'downloading' }]))
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
})
