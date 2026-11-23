import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp } from '@app/createApp'
import { selectConnection } from '@app/core/connectionSlice'
import { coreApi } from '@app/core/coreApi'
import { coreEvent } from '@app/core/events'
import type { Event, Model } from '@app/core/generated'
import type { CoreConnection, CoreState } from '@shared/core'
import { fakePlatform } from '../fakePlatform'
import { createFakeCoreHttp } from '../fakeCoreHttp'

// Listener effects and promises run after dispatch returns; one macrotask lets them finish.
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

const connection: CoreConnection = { baseUrl: 'http://127.0.0.1:53121', token: 'a'.repeat(64) }
const ready = (to: CoreConnection): CoreState => ({
  status: 'ready',
  port: 53121,
  version: '1.0.0',
  connection: to
})

describe("core's connection", () => {
  it('a ready state pushed by main sets the connection; a starting state clears it', () => {
    const fake = fakePlatform()
    const store = createApp({ platform: fake.platform })

    fake.core.emit(ready(connection))
    expect(selectConnection(store.getState())).toEqual(connection)

    fake.core.emit({ status: 'starting' })
    expect(selectConnection(store.getState())).toBeNull()
  })

  it("ignores getState's answer when a newer state was already pushed", async () => {
    const fake = fakePlatform()
    const store = createApp({ platform: fake.platform })

    fake.core.emit(ready(connection))
    fake.core.answer({ status: 'starting' })
    await settle()

    expect(selectConnection(store.getState())).toEqual(connection)
  })

  it('keeps the same object when an equal connection is pushed twice', () => {
    const fake = fakePlatform()
    const store = createApp({ platform: fake.platform })

    fake.core.emit(ready(connection))
    const first = selectConnection(store.getState())
    fake.core.emit(ready({ ...connection }))

    expect(selectConnection(store.getState())).toBe(first)
  })
})

describe('core events', () => {
  it('an event type no feature knows leaves the state as it was', () => {
    const store = createApp({ platform: fakePlatform().platform })
    const unknown = { time: 1, stream: 'system', type: 'run.started', v: 1, data: {} }

    // The first action of any kind registers the query middleware in the state; compare from the second.
    store.dispatch(coreEvent(unknown as unknown as Event))
    const before = store.getState()
    store.dispatch(coreEvent(unknown as unknown as Event))

    expect(store.getState()).toBe(before)
  })

  describe('on the stream', () => {
    beforeEach(() => {
      vi.useFakeTimers()
    })

    afterEach(() => {
      vi.useRealTimers()
      vi.restoreAllMocks()
    })

    /** Lets pending promises and stream reads run, without moving the clock, until the condition holds. */
    async function until(condition: () => boolean): Promise<void> {
      for (let turn = 0; turn < 100; turn++) {
        if (condition()) return
        await vi.advanceTimersByTimeAsync(0)
      }
      throw new Error('condition not met after 100 turns')
    }

    it('a model.state frame on the stream fills listModels', async () => {
      const http = createFakeCoreHttp()
      vi.stubGlobal('fetch', http.fetch)
      const fake = fakePlatform()
      const store = createApp({ platform: fake.platform })
      fake.core.emit(ready(connection))
      await until(() => http.openStreams() === 1)
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
        tags: [],
        memory: null
      }

      http.push({ data: { time: 1, stream: 'system', type: 'model.state', v: 1, data: { models: [model] } } })

      const cached = (): unknown => coreApi.endpoints.listModels.select()(store.getState()).data
      await until(() => cached() !== undefined)
      expect(cached()).toEqual({ models: [model] })
      fake.core.emit({ status: 'starting' })
    })
  })
})
