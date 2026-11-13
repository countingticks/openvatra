// Plays core's HTTP side for the window's data layer: JSON answers per path, and /api/events streams the test
// pushes frames into. Stubbed in as fetch, so the real base query and event stream run against it.

import type { ModelInfo } from '../../src/shared/core'
import type { DownloadItem } from '../../src/shared/setup'

export interface FakeCoreHttp {
  fetch: typeof fetch
  /** JSON answer for a method and path (default method GET, status 200); unknown paths answer 404 not_found. */
  answer(path: string, body: unknown, options?: { method?: string; status?: number }): void
  /** Sends one frame to every open /api/events stream. */
  push(frame: { event?: 'hello'; data: unknown }): void
  /** Sets GET /api/models and sends model.state (retained, no seq) to open streams; new streams get it after hello. */
  setModels(models: ModelInfo[]): void
  /** Same for GET /api/downloads and download.progress. */
  setDownloads(items: DownloadItem[]): void
  /** Ends every open stream, as a core that went away. */
  endStreams(): void
  /** Every request seen: url, method, Authorization header. */
  requests: { url: string; method: string; authorization: string | null }[]
  openStreams(): number
  /** The hello each new stream starts with; default { log: 'log-1', head: 0, reset: false }. */
  hello: { log: string; head: number; reset: boolean }
}

type Frame = { event?: 'hello'; data: unknown }

const encoder = new TextEncoder()

const encodeFrame = (frame: Frame): Uint8Array =>
  encoder.encode(`${frame.event ? `event: ${frame.event}\n` : ''}data: ${JSON.stringify(frame.data)}\n\n`)

const json = (body: unknown, status: number): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

/** The parts of a fetch call the fake needs, whether it got a Request (RTK Query) or a URL and init. */
function describeCall(
  input: RequestInfo | URL,
  init?: RequestInit
): { url: string; method: string; authorization: string | null; signal: AbortSignal | null } {
  const request = input instanceof Request ? input : null
  const url = request ? request.url : input instanceof URL ? input.href : String(input)
  return {
    url,
    method: (init?.method ?? request?.method ?? 'GET').toUpperCase(),
    authorization: new Headers(init?.headers ?? request?.headers).get('Authorization'),
    signal: init?.signal ?? request?.signal ?? null
  }
}

const retainedEvent = (type: string, data: unknown): Frame => ({
  data: { type, v: 1, stream: 'system', time: 0, data }
})

export function createFakeCoreHttp(): FakeCoreHttp {
  let models: ModelInfo[] = []
  let downloads: DownloadItem[] = []
  const answers = new Map<string, { body: unknown; status: number }>()
  const streams = new Set<ReadableStreamDefaultController<Uint8Array>>()

  function openStream(signal: AbortSignal | null): Response {
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        controller = c
        streams.add(c)
        c.enqueue(encodeFrame({ event: 'hello', data: fake.hello }))
        c.enqueue(encodeFrame(retainedEvent('model.state', { models })))
        c.enqueue(encodeFrame(retainedEvent('download.progress', { items: downloads })))
      },
      cancel() {
        if (controller) streams.delete(controller)
      }
    })
    signal?.addEventListener('abort', () => {
      if (!controller || !streams.delete(controller)) return
      controller.error(new DOMException('The request was aborted', 'AbortError'))
    })
    return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
  }

  const fake: FakeCoreHttp = {
    requests: [],
    hello: { log: 'log-1', head: 0, reset: false },
    fetch: async (input, init) => {
      const call = describeCall(input, init)
      fake.requests.push({ url: call.url, method: call.method, authorization: call.authorization })
      if (call.signal?.aborted) throw new DOMException('The request was aborted', 'AbortError')
      const path = new URL(call.url).pathname
      const answer = answers.get(`${call.method} ${path}`)
      if (answer) return json(answer.body, answer.status)
      if (call.method === 'GET' && path === '/api/events') return openStream(call.signal)
      return json({ error: 'not_found', message: `no route for ${call.method} ${path}` }, 404)
    },
    answer: (path, body, options = {}) => {
      answers.set(`${(options.method ?? 'GET').toUpperCase()} ${path}`, {
        body,
        status: options.status ?? 200
      })
    },
    setModels: (list) => {
      models = list
      fake.answer('/api/models', { models })
      fake.push(retainedEvent('model.state', { models }))
    },
    setDownloads: (items) => {
      downloads = items
      fake.answer('/api/downloads', { items })
      fake.push(retainedEvent('download.progress', { items }))
    },
    push: (frame) => {
      const bytes = encodeFrame(frame)
      streams.forEach((stream) => stream.enqueue(bytes))
    },
    endStreams: () => {
      streams.forEach((stream) => stream.close())
      streams.clear()
    },
    openStreams: () => streams.size
  }
  return fake
}
