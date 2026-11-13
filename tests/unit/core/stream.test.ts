import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { coreApi } from '@renderer/core/coreApi'
import type { Event, Model } from '@renderer/core/generated'
import { createAppStore, type AppStore } from '@renderer/store/store'
import type { CoreConnection, CoreState } from '../../../src/shared/core'
import type { CoreApi } from '../../../src/shared/ipc'
import { defaultSettings } from '../../../src/shared/settings'
import { createFakeCoreHttp, type FakeCoreHttp } from '../fakeCoreHttp'

const first: CoreConnection = { baseUrl: 'http://127.0.0.1:53121', token: 'a'.repeat(64) }
const second: CoreConnection = { baseUrl: 'http://127.0.0.1:53999', token: 'b'.repeat(64) }
const ready = (to: CoreConnection): CoreState => ({
  status: 'ready',
  port: Number(new URL(to.baseUrl).port),
  version: '1.0.0',
  connection: to
})

const model: Model = { id: 'qwen3-8b', state: 'ready', busy: false, kind: 'chat', sizeBytes: 5_000_000_000 }

const modelState: Event = {
  time: 1,
  stream: 'system',
  type: 'model.state',
  v: 1,
  data: { models: [model] }
}

interface Harness {
  store: AppStore
  http: FakeCoreHttp
  /** Plays main's core:state push. */
  push(state: CoreState): void
  /** The /api/events requests so far. */
  streamRequests(): { url: string; authorization: string | null }[]
}

let harness: Harness | undefined

function setup(): Harness {
  const http = createFakeCoreHttp()
  vi.stubGlobal('fetch', http.fetch)
  let listener: ((state: CoreState) => void) | undefined
  const core: Pick<CoreApi, 'getState' | 'onState'> = {
    getState: () => new Promise(() => {}),
    onState: (callback) => {
      listener = callback
      return () => (listener = undefined)
    }
  }
  const store = createAppStore({
    settings: { update: vi.fn().mockResolvedValue(defaultSettings), onChange: () => () => {} },
    core
  })
  harness = {
    store,
    http,
    push: (state) => listener?.(state),
    streamRequests: () => http.requests.filter((request) => new URL(request.url).pathname === '/api/events')
  }
  return harness
}

/** Lets pending promises and stream reads run, without moving the clock, until the condition holds. */
async function until(condition: () => boolean): Promise<void> {
  for (let turn = 0; turn < 100; turn++) {
    if (condition()) return
    await vi.advanceTimersByTimeAsync(0)
  }
  throw new Error('condition not met after 100 turns')
}

/** Lets everything pending settle without moving the clock. */
async function settle(): Promise<void> {
  for (let turn = 0; turn < 20; turn++) await vi.advanceTimersByTimeAsync(0)
}

const cachedModels = (store: AppStore): unknown =>
  coreApi.endpoints.listModels.select()(store.getState()).data

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  // The stream lives as long as its store; closing it keeps a test's stream from outliving the test.
  harness?.push({ status: 'starting' })
  harness = undefined
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('followCoreStream', () => {
  it('opens one stream on a ready state, with the bearer header, stream=system and no after the first time', async () => {
    const { http, push, streamRequests } = setup()

    push(ready(first))
    await until(() => http.openStreams() === 1)

    expect(streamRequests()).toEqual([
      expect.objectContaining({
        url: 'http://127.0.0.1:53121/api/events?stream=system',
        authorization: `Bearer ${first.token}`
      })
    ])
  })

  it('fills listModels from a model.state frame and listDownloads from a download.progress frame', async () => {
    const { store, http, push } = setup()
    push(ready(first))
    await until(() => http.openStreams() === 1)
    const downloads = { items: [{ id: 'qwen3-8b', state: 'downloading', bytes: 1, total: 2, speed: 1 }] }

    http.push({ data: modelState })
    http.push({ data: { time: 2, stream: 'system', type: 'download.progress', v: 1, data: downloads } })

    await until(() => cachedModels(store) !== undefined)
    expect(cachedModels(store)).toEqual({ models: [model] })
    await until(() => coreApi.endpoints.listDownloads.select()(store.getState()).data !== undefined)
    expect(coreApi.endpoints.listDownloads.select()(store.getState()).data).toEqual(downloads)
  })

  it("sends a durable event's seq and the hello's log as after and log on the next connection", async () => {
    const { http, push, streamRequests } = setup()
    push(ready(first))
    await until(() => http.openStreams() === 1)

    http.push({
      data: {
        seq: 7,
        time: 1,
        stream: 'system',
        type: 'config.changed',
        v: 1,
        data: { section: 'models', rev: 2 }
      }
    })
    await settle()
    http.endStreams()
    await settle()
    await vi.advanceTimersByTimeAsync(500)
    await until(() => streamRequests().length === 2)

    expect(streamRequests()[1].url).toBe('http://127.0.0.1:53121/api/events?stream=system&after=7&log=log-1')
  })

  it('reconnects 0.5 s after core ends the stream, then 1 s later if that fails, with the bookmark', async () => {
    const { http, push, streamRequests } = setup()
    push(ready(first))
    await until(() => http.openStreams() === 1)
    http.answer('/api/events', { error: 'unavailable', message: 'core is stopping' }, { status: 503 })

    http.endStreams()
    await settle()
    await vi.advanceTimersByTimeAsync(499)
    await settle()
    expect(streamRequests()).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    await until(() => streamRequests().length === 2)

    await settle()
    await vi.advanceTimersByTimeAsync(999)
    await settle()
    expect(streamRequests()).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(1)
    await until(() => streamRequests().length === 3)

    const bookmarked = 'http://127.0.0.1:53121/api/events?stream=system&after=0&log=log-1'
    expect(
      streamRequests()
        .map((request) => request.url)
        .slice(1)
    ).toEqual([bookmarked, bookmarked])
  })

  it('aborts the old stream and opens one on the new base URL when the connection changes', async () => {
    const { http, push, streamRequests } = setup()
    push(ready(first))
    await until(() => http.openStreams() === 1)
    await settle() // the hello is read, so there is a bookmark to send

    push(ready(second))
    await until(() => streamRequests().length === 2)
    await settle()

    expect(http.openStreams()).toBe(1)
    expect(streamRequests()[1]).toEqual(
      expect.objectContaining({
        url: 'http://127.0.0.1:53999/api/events?stream=system&after=0&log=log-1',
        authorization: `Bearer ${second.token}`
      })
    )
  })

  it('closes the stream on a starting state and opens nothing until the next ready', async () => {
    const { http, push, streamRequests } = setup()
    push(ready(first))
    await until(() => http.openStreams() === 1)

    push({ status: 'starting' })
    await until(() => http.openStreams() === 0)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(streamRequests()).toHaveLength(1)

    push(ready(first))
    await until(() => http.openStreams() === 1)
    expect(streamRequests()).toHaveLength(2)
  })

  it('skips a malformed frame and still applies the next one', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { store, http, push } = setup()
    push(ready(first))
    await until(() => http.openStreams() === 1)

    http.push({ data: 'not an event' })
    http.push({ data: modelState })

    await until(() => cachedModels(store) !== undefined)
    expect(cachedModels(store)).toEqual({ models: [model] })
    expect(warn).toHaveBeenCalledOnce()
  })

  it('fetches a query again once the connection arrives, when it failed before', async () => {
    const { store, http, push } = setup()
    http.answer('/api/version', { api: 1, version: '1.0.0' })
    const query = store.dispatch(coreApi.endpoints.getVersion.initiate())
    expect((await query).error).toEqual({ status: 'CORE_UNAVAILABLE' })

    push(ready(first))

    const version = (): unknown => coreApi.endpoints.getVersion.select()(store.getState()).data
    await until(() => version() !== undefined)
    expect(version()).toEqual({ api: 1, version: '1.0.0' })
    query.unsubscribe()
  })
})
