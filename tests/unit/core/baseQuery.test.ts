import { afterEach, describe, expect, it, vi, type Mock } from 'vitest'
import { coreApi } from '@renderer/core/coreApi'
import { createAppStore, type AppStore } from '@renderer/store/store'
import type { CoreConnection, CoreState } from '../../../src/shared/core'
import type { CoreApi } from '../../../src/shared/ipc'
import { defaultSettings } from '../../../src/shared/settings'

const connection: CoreConnection = { baseUrl: 'http://127.0.0.1:53121', token: 'a'.repeat(64) }
const ready = (to: CoreConnection): CoreState => ({
  status: 'ready',
  port: 53121,
  version: '1.0.0',
  connection: to
})

/** A store whose core state is set by the test through push. */
function storeWithCore(): { store: AppStore; push(state: CoreState): void } {
  let listener: ((state: CoreState) => void) | undefined
  const core: Pick<CoreApi, 'getState' | 'onState'> = {
    getState: () => new Promise(() => {}),
    onState: (callback) => {
      listener = callback
      return () => (listener = undefined)
    }
  }
  const settings = { update: vi.fn().mockResolvedValue(defaultSettings), onChange: () => () => {} }
  const store = createAppStore({ settings, core })
  return { store, push: (state) => listener?.(state) }
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

type FetchMock = Mock<typeof globalThis.fetch>

/** What fetch was called with, whether RTK passed a Request or a URL and init. */
const asRequest = (input: RequestInfo | URL, init?: RequestInit): Request =>
  input instanceof Request ? input : new Request(input, init)

/**
 * Stubs fetch with answer for every request but the window's event stream (which the store opens once it has a
 * connection, and which is left pending here: it is not what these tests are about).
 */
function stubFetch(answer: () => Response): FetchMock {
  const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) =>
    new URL(asRequest(input, init).url).pathname === '/api/events'
      ? new Promise<Response>(() => {})
      : answer()
  )
  vi.stubGlobal('fetch', fetch)
  return fetch
}

/** The requests the generated endpoints made, in order. */
const sent = (fetch: FetchMock): Request[] =>
  fetch.mock.calls
    .map(([input, init]) => asRequest(input, init))
    .filter((request) => new URL(request.url).pathname !== '/api/events')

async function getVersion(store: AppStore): Promise<{ data?: unknown; error?: unknown }> {
  const request = store.dispatch(coreApi.endpoints.getVersion.initiate(undefined, { forceRefetch: true }))
  const { data, error } = await request
  request.unsubscribe()
  return { data, error }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('coreBaseQuery', () => {
  it('fails with CORE_UNAVAILABLE without a connection and never calls fetch', async () => {
    const fetch = stubFetch(() => json({ api: 1, version: '1.0.0' }))
    const { store } = storeWithCore()

    const result = await getVersion(store)

    expect(result.error).toEqual({ status: 'CORE_UNAVAILABLE' })
    expect(fetch).not.toHaveBeenCalled()
  })

  it("sends the request to the connection's base URL with the bearer token", async () => {
    const fetch = stubFetch(() => json({ api: 1, version: '1.0.0' }))
    const { store, push } = storeWithCore()
    push(ready(connection))

    const result = await getVersion(store)

    expect(result.data).toEqual({ api: 1, version: '1.0.0' })
    const [request] = sent(fetch)
    expect(request.url).toBe('http://127.0.0.1:53121/api/version')
    expect(request.headers.get('Authorization')).toBe(`Bearer ${connection.token}`)
  })

  it("uses a new connection's token on the next request", async () => {
    const fetch = stubFetch(() => json({ api: 1, version: '1.0.0' }))
    const { store, push } = storeWithCore()
    push(ready(connection))
    await getVersion(store)

    push(ready({ baseUrl: 'http://127.0.0.1:53999', token: 'b'.repeat(64) }))
    await getVersion(store)

    const request = sent(fetch)[1]
    expect(request.url).toBe('http://127.0.0.1:53999/api/version')
    expect(request.headers.get('Authorization')).toBe(`Bearer ${'b'.repeat(64)}`)
  })

  it("keeps core's error body, extra fields included", async () => {
    const body = { error: 'config_conflict', message: 'rev is stale', current: { rev: 4 } }
    stubFetch(() => json(body, 409))
    const { store, push } = storeWithCore()
    push(ready(connection))

    const result = await getVersion(store)

    expect(result.error).toEqual({ status: 409, data: body })
  })

  it("turns an error body that is not core's into a plain message", async () => {
    stubFetch(
      () =>
        new Response('<html>Bad gateway</html>', { status: 502, headers: { 'content-type': 'text/html' } })
    )
    const { store, push } = storeWithCore()
    push(ready(connection))

    const result = await getVersion(store)

    expect(result.error).toEqual({
      status: 502,
      data: { error: 'unknown', message: 'core answered HTTP 502' }
    })
  })
})
