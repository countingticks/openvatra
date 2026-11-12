// @vitest-environment node
import { afterEach, describe, expect, it, type Mock, vi } from 'vitest'
import { createModelsClient, takeSseEvents } from '../../../src/main/core/modelsClient'
import type { ModelInfo } from '../../../src/shared/core'

type Request = (path: string, init?: RequestInit) => Promise<Response>

const qwen: ModelInfo = { id: 'qwen', state: 'stopped', busy: false, sizeBytes: 5_000, kind: 'chat' }
const stateEvent = (models: unknown): string => `event: state\ndata: ${JSON.stringify({ models })}\n\n`

describe('takeSseEvents', () => {
  it('returns complete events and keeps an unfinished one for the next chunk', () => {
    expect(takeSseEvents('event: state\ndata: {"a":1}\n\nevent: sta')).toEqual({
      events: [{ event: 'state', data: '{"a":1}' }],
      rest: 'event: sta'
    })
  })

  it('handles CRLF, comments, the default event name and data spread over lines', () => {
    expect(takeSseEvents(': keep-alive\r\n\r\ndata: one\r\ndata: two\r\n\r\n').events).toEqual([
      { event: 'message', data: '' },
      { event: 'message', data: 'one\ntwo' }
    ])
  })
})

/** A fake core: each call to /api/events gets a stream the test writes to, like core's real one. */
function fakeCore(): {
  request: Mock<Request>
  streams: { send: (text: string) => void; end: () => void; signal: AbortSignal }[]
} {
  const streams: { send: (text: string) => void; end: () => void; signal: AbortSignal }[] = []
  const request = vi.fn<Request>(async (_path, init) => {
    const signal = init?.signal ?? new AbortController().signal
    let controller!: ReadableStreamDefaultController<Uint8Array>
    const body = new ReadableStream<Uint8Array>({ start: (c) => void (controller = c) })
    signal.addEventListener('abort', () => controller.error(new DOMException('aborted', 'AbortError')))
    const encoder = new TextEncoder()
    streams.push({
      send: (text) => controller.enqueue(encoder.encode(text)),
      end: () => controller.close(),
      signal
    })
    return new Response(body)
  })
  return { request, streams }
}

function setUp(request: Request): {
  client: ReturnType<typeof createModelsClient>
  onModels: ReturnType<typeof vi.fn>
  onDownloads: ReturnType<typeof vi.fn>
  warn: ReturnType<typeof vi.fn>
} {
  const onModels = vi.fn()
  const onDownloads = vi.fn()
  const warn = vi.fn()
  return {
    client: createModelsClient({ request, onModels, onDownloads, log: { warn } }),
    onModels,
    onDownloads,
    warn
  }
}

const downloadsEvent = (items: unknown): string => `event: downloads
data: ${JSON.stringify({ items })}

`

describe('models client: downloads', () => {
  const running = { id: 'qwen3-8b', state: 'downloading', bytes: 10, total: 100, speed: 5 }

  it('reports the download queue from the same stream and keeps the latest for late windows', async () => {
    const core = fakeCore()
    const { client, onDownloads } = setUp(core.request)
    client.start()
    await vi.waitFor(() => expect(core.streams).toHaveLength(1))

    core.streams[0].send(downloadsEvent([running]))

    await vi.waitFor(() => expect(onDownloads).toHaveBeenCalledWith([running]))
    expect(client.downloads()).toEqual([running])
  })

  it('ignores a malformed queue, and empties it on stop', async () => {
    const core = fakeCore()
    const { client, onDownloads, warn } = setUp(core.request)
    client.start()
    await vi.waitFor(() => expect(core.streams).toHaveLength(1))

    core.streams[0].send(downloadsEvent([{ id: 'x', state: 'exploded' }]))
    await vi.waitFor(() => expect(warn).toHaveBeenCalledTimes(1))
    expect(onDownloads).not.toHaveBeenCalled()

    core.streams[0].send(downloadsEvent([running]))
    await vi.waitFor(() => expect(client.downloads()).toEqual([running]))
    client.stop()
    expect(client.downloads()).toEqual([])
  })
})

describe('models client: following core', () => {
  afterEach(() => vi.useRealTimers())

  it('reports each model list from the event stream, even one split across chunks', async () => {
    const core = fakeCore()
    const { client, onModels } = setUp(core.request)

    client.start()
    await vi.waitFor(() => expect(core.streams).toHaveLength(1))
    const event = stateEvent([qwen])
    core.streams[0].send(event.slice(0, 10))
    core.streams[0].send(event.slice(10))

    await vi.waitFor(() => expect(onModels).toHaveBeenCalledWith([qwen]))
    expect(onModels).toHaveBeenCalledTimes(1)
    expect(client.list()).toEqual([qwen])
    expect(core.request).toHaveBeenCalledWith(
      '/api/events',
      expect.objectContaining({ signal: expect.anything() })
    )
  })

  it('ignores a malformed list and says so in the log', async () => {
    const core = fakeCore()
    const { client, onModels, warn } = setUp(core.request)
    client.start()
    await vi.waitFor(() => expect(core.streams).toHaveLength(1))

    core.streams[0].send(stateEvent([{ id: 'qwen', state: 'exploded' }]))
    core.streams[0].send('event: state\ndata: not json\n\n')

    await vi.waitFor(() => expect(warn).toHaveBeenCalledTimes(2))
    expect(onModels).not.toHaveBeenCalled()
  })

  it('stop closes the stream and empties the list, without retrying', async () => {
    vi.useFakeTimers()
    const core = fakeCore()
    const { client, onModels, warn } = setUp(core.request)
    client.start()
    await vi.waitFor(() => expect(core.streams).toHaveLength(1))
    core.streams[0].send(stateEvent([qwen]))
    await vi.waitFor(() => expect(client.list()).toEqual([qwen]))

    client.stop()
    await vi.advanceTimersByTimeAsync(10_000)

    expect(core.streams[0].signal.aborted).toBe(true)
    expect(onModels).toHaveBeenLastCalledWith([])
    expect(core.request).toHaveBeenCalledTimes(1)
    expect(warn).not.toHaveBeenCalled() // a stop is not a failure
  })

  it('reopens a stream that ended while core was still up', async () => {
    vi.useFakeTimers()
    const core = fakeCore()
    const { client, onModels } = setUp(core.request)
    client.start()
    await vi.waitFor(() => expect(core.streams).toHaveLength(1))
    core.streams[0].send(stateEvent([qwen]))
    await vi.waitFor(() => expect(client.list()).toEqual([qwen]))

    core.streams[0].end()
    await vi.waitFor(() => expect(onModels).toHaveBeenLastCalledWith([]))
    await vi.advanceTimersByTimeAsync(2_000)

    expect(core.streams).toHaveLength(2)
    client.stop()
  })

  it('a second start replaces the first stream', async () => {
    const core = fakeCore()
    const { client } = setUp(core.request)
    client.start()
    client.start()

    await vi.waitFor(() => expect(core.streams).toHaveLength(2))
    expect(core.streams[0].signal.aborted).toBe(true)
    expect(core.streams[1].signal.aborted).toBe(false)
    client.stop()
  })
})

describe('models client: load and unload', () => {
  it('POSTs to the model, with the id made safe for a URL', async () => {
    const request = vi.fn<Request>().mockResolvedValue(new Response(null, { status: 200 }))
    const { client } = setUp(request)

    await client.load('a/b c')
    await client.unload('qwen')

    expect(request).toHaveBeenCalledWith('/api/models/a%2Fb%20c/load', { method: 'POST' })
    expect(request).toHaveBeenCalledWith('/api/models/qwen/unload', { method: 'POST' })
  })

  it("rejects with core's own message, or a generic one when there is none", async () => {
    const coreError = { error: 'load_failed', message: 'llama-server.exe not found' }
    const request = vi
      .fn<Request>()
      .mockResolvedValueOnce(Response.json(coreError, { status: 503 }))
      .mockResolvedValueOnce(new Response('oops', { status: 500 }))
    const { client } = setUp(request)

    await expect(client.load('qwen')).rejects.toThrow('llama-server.exe not found')
    await expect(client.load('qwen')).rejects.toThrow('core answered with HTTP 500')
  })
})
