// @vitest-environment node
import { afterEach, describe, expect, it, type Mock, vi } from 'vitest'
import { createModelsClient, takeSseEvents } from '../../../src/main/core/modelsClient'
import type { ModelInfo } from '../../../src/shared/core'

type Request = (path: string, init?: RequestInit) => Promise<Response>

const qwen: ModelInfo = { id: 'qwen', state: 'stopped', busy: false, sizeBytes: 5_000, kind: 'chat' }
const hello = (log: string, head: number, reset = false): string =>
  `event: hello\ndata: ${JSON.stringify({ log, head, reset })}\n\n`
/** A log event frame; a durable one (with seq) also gets its "id:" line, as core sends it. */
const envelope = (type: string, data: unknown, seq?: number): string => {
  const body = JSON.stringify({ seq, time: 1, stream: 'system', type, v: 1, data })
  return `${seq === undefined ? '' : `id: ${seq}\n`}data: ${body}\n\n`
}
const stateEvent = (models: unknown): string => envelope('model.state', { models })
const configEvent = (data: unknown, seq: number): string => envelope('config.changed', data, seq)

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
  onConfig: ReturnType<typeof vi.fn>
  onReset: ReturnType<typeof vi.fn>
  warn: ReturnType<typeof vi.fn>
} {
  const onModels = vi.fn()
  const onDownloads = vi.fn()
  const onConfig = vi.fn()
  const onReset = vi.fn()
  const warn = vi.fn()
  return {
    client: createModelsClient({ request, onModels, onDownloads, onConfig, onReset, log: { warn } }),
    onModels,
    onDownloads,
    onConfig,
    onReset,
    warn
  }
}

const downloadsEvent = (items: unknown): string => envelope('download.progress', { items })

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

describe('models client: config events', () => {
  it('a config event reaches onConfig', async () => {
    const core = fakeCore()
    const { client, onConfig } = setUp(core.request)
    client.start()
    await vi.waitFor(() => expect(core.streams).toHaveLength(1))

    core.streams[0].send(configEvent({ section: 'models', rev: 5 }, 1))

    await vi.waitFor(() => expect(onConfig).toHaveBeenCalledWith('models', 5))
    client.stop()
  })

  it.each([
    ['not an object', 'nope'],
    ['no section', { rev: 3 }],
    ['a rev that is not an integer', { section: 'models', rev: 1.5 }],
    ['a rev that is text', { section: 'models', rev: '3' }]
  ])('a malformed config event is dropped with a warning (%s)', async (_case, data) => {
    const core = fakeCore()
    const { client, onConfig, warn } = setUp(core.request)
    client.start()
    await vi.waitFor(() => expect(core.streams).toHaveLength(1))

    core.streams[0].send(configEvent(data, 1))

    await vi.waitFor(() => expect(warn).toHaveBeenCalledWith('core: ignored a malformed config event'))
    expect(onConfig).not.toHaveBeenCalled()
    client.stop()
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
  })

  it('the first request asks for the system stream only', async () => {
    const core = fakeCore()
    const { client } = setUp(core.request)
    client.start()
    await vi.waitFor(() => expect(core.streams).toHaveLength(1))

    expect(core.request).toHaveBeenCalledWith(
      '/api/events?stream=system',
      expect.objectContaining({ signal: expect.anything() })
    )
    client.stop()
  })

  it('ignores a malformed list and says so in the log', async () => {
    const core = fakeCore()
    const { client, onModels, warn } = setUp(core.request)
    client.start()
    await vi.waitFor(() => expect(core.streams).toHaveLength(1))

    core.streams[0].send(stateEvent([{ id: 'qwen', state: 'exploded' }]))
    core.streams[0].send('data: not json\n\n')

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

describe('models client: bookmark', () => {
  afterEach(() => vi.useRealTimers())

  const lastPath = (request: Mock<Request>): string => request.mock.lastCall?.[0] ?? ''

  it('a reconnect sends the last durable seq and the log id', async () => {
    vi.useFakeTimers()
    const core = fakeCore()
    const { client } = setUp(core.request)
    client.start()
    await vi.waitFor(() => expect(core.streams).toHaveLength(1))
    core.streams[0].send(hello('a', 7))
    core.streams[0].send(configEvent({ section: 'models', rev: 2 }, 9))
    core.streams[0].send(stateEvent([qwen]))
    await vi.waitFor(() => expect(client.list()).toEqual([qwen]))

    core.streams[0].end()
    await vi.advanceTimersByTimeAsync(2_000)

    expect(core.streams).toHaveLength(2)
    expect(lastPath(core.request)).toBe('/api/events?stream=system&after=9&log=a')
    client.stop()
  })

  it('a core restart (stop, then start) sends the same bookmark', async () => {
    const core = fakeCore()
    const { client, onConfig } = setUp(core.request)
    client.start()
    await vi.waitFor(() => expect(core.streams).toHaveLength(1))
    core.streams[0].send(hello('a', 7))
    core.streams[0].send(configEvent({ section: 'models', rev: 2 }, 9))
    await vi.waitFor(() => expect(onConfig).toHaveBeenCalled())

    client.stop()
    client.start()
    await vi.waitFor(() => expect(core.streams).toHaveLength(2))

    expect(lastPath(core.request)).toBe('/api/events?stream=system&after=9&log=a')
    client.stop()
  })

  it('a hello with reset calls onReset once and the next reconnect starts from its head', async () => {
    vi.useFakeTimers()
    const core = fakeCore()
    const { client, onReset } = setUp(core.request)
    client.start()
    await vi.waitFor(() => expect(core.streams).toHaveLength(1))
    core.streams[0].send(hello('a', 7))
    core.streams[0].send(configEvent({ section: 'models', rev: 2 }, 9))
    core.streams[0].end()
    await vi.advanceTimersByTimeAsync(2_000)
    expect(core.streams).toHaveLength(2)

    core.streams[1].send(hello('a', 3, true))
    await vi.waitFor(() => expect(onReset).toHaveBeenCalledTimes(1))
    core.streams[1].end()
    await vi.advanceTimersByTimeAsync(2_000)

    expect(core.streams).toHaveLength(3)
    expect(lastPath(core.request)).toBe('/api/events?stream=system&after=3&log=a')
    expect(onReset).toHaveBeenCalledTimes(1)
    client.stop()
  })

  it('a hello naming another log calls onReset; the first hello never does', async () => {
    const core = fakeCore()
    const { client, onReset, onModels } = setUp(core.request)
    client.start()
    await vi.waitFor(() => expect(core.streams).toHaveLength(1))
    core.streams[0].send(hello('', 0))
    core.streams[0].send(stateEvent([qwen]))
    await vi.waitFor(() => expect(onModels).toHaveBeenCalledWith([qwen]))
    expect(onReset).not.toHaveBeenCalled()

    client.stop()
    client.start()
    await vi.waitFor(() => expect(core.streams).toHaveLength(2))
    core.streams[1].send(hello('b', 4))

    await vi.waitFor(() => expect(onReset).toHaveBeenCalledTimes(1))
    client.stop()
  })
})

describe('models client: malformed and unknown frames', () => {
  it('logs one warning per connection for malformed frames and still handles a valid one after them', async () => {
    const core = fakeCore()
    const { client, onModels, warn } = setUp(core.request)
    client.start()
    await vi.waitFor(() => expect(core.streams).toHaveLength(1))

    core.streams[0].send('data: not json\n\n')
    core.streams[0].send(`data: ${JSON.stringify({ type: 'model.state', stream: 'system', v: 1 })}\n\n`)
    core.streams[0].send(stateEvent([qwen]))

    await vi.waitFor(() => expect(onModels).toHaveBeenCalledWith([qwen]))
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledWith('core: ignored a malformed event')
    client.stop()
  })

  it('ignores an unknown type, a named event other than hello and a keepalive, without a warning', async () => {
    const core = fakeCore()
    const { client, onModels, onDownloads, onConfig, warn } = setUp(core.request)
    client.start()
    await vi.waitFor(() => expect(core.streams).toHaveLength(1))

    core.streams[0].send(envelope('chat.delta', { text: 'hi' }, 3))
    core.streams[0].send('event: other\ndata: {"models":[]}\n\n')
    core.streams[0].send(': keepalive\n\n')
    core.streams[0].send(stateEvent([qwen]))

    await vi.waitFor(() => expect(onModels).toHaveBeenCalledWith([qwen]))
    expect(onModels).toHaveBeenCalledTimes(1)
    expect(onDownloads).not.toHaveBeenCalled()
    expect(onConfig).not.toHaveBeenCalled()
    expect(warn).not.toHaveBeenCalled()
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
