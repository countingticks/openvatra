// Plays core's HTTP side for the window's data layer: JSON answers per path, the write routes the window calls,
// the two model config sections with their revs, and /api/events streams the test pushes frames into. Stubbed in as fetch,
// so the real base query and event stream run against it.

import { defaultEngineSettings, defaultLlamacppSettings } from '@app/features/models/modelSettings'
import type { Choice } from '@app/core/generated'
import type { ModelInfo } from '@app/core/types'
import type { DownloadItem } from '@app/core/types'

export interface CoreRequest {
  url: string
  method: string
  authorization: string | null
  /** The JSON-parsed request body; undefined when there is none. */
  body: unknown
}

type Handler = (request: CoreRequest) => { status?: number; body?: unknown }

export type ConfigSection = 'engine.llamaserver' | 'provider.llamacpp' | 'chat'

export interface ConfigEntry {
  rev: number
  value: unknown
  effective?: unknown
}

export interface FakeCoreHttp {
  fetch: typeof fetch
  /** JSON answer for a method and path (default method GET, status 200); unknown paths answer 404 not_found. */
  answer(path: string, body: unknown, options?: { method?: string; status?: number }): void
  /** Answers method + path with whatever handler returns; replaces the default and any earlier answer. */
  respond(method: string, path: string, handler: Handler): void
  /** Sets the entry GET /api/config/<section> answers and PUT compares with. */
  setConfig(section: ConfigSection, entry: ConfigEntry): void
  /** Sends one frame to every open /api/events stream. */
  push(frame: { event?: 'hello'; data: unknown }): void
  /** Sets GET /api/models and sends model.state (retained, no seq) to open streams; new streams get it after hello. */
  setModels(models: ModelInfo[]): void
  /** Same for GET /api/downloads and download.progress. */
  setDownloads(items: DownloadItem[]): void
  /** Ends every open stream, as a core that went away. */
  endStreams(): void
  /** What GET /api/models/{id}/fit answers; default 32768 tokens that fit on the GPU. */
  fit: Choice
  /** Every request seen. */
  requests: CoreRequest[]
  openStreams(): number
  /** The hello each new stream starts with; default { log: 'log-1', head: 0, reset: false }. */
  hello: { log: string; head: number; reset: boolean }
}

/** The query of each GET /api/models/{id}/fit seen, as context and placement: what the window asked about. */
export const fitQueries = (fake: FakeCoreHttp): { context: string | null; placement: string | null }[] =>
  fake.requests
    .map((request) => new URL(request.url))
    .filter((url) => /^\/api\/models\/[^/]+\/fit$/.test(url.pathname))
    .map((url) => ({
      context: url.searchParams.get('context'),
      placement: url.searchParams.get('placement')
    }))

/** The requests that change something (not GET), as method, path and body: what tests assert the window sent. */
export const coreWrites = (fake: FakeCoreHttp): { method: string; path: string; body: unknown }[] =>
  fake.requests
    .filter((request) => request.method !== 'GET')
    .map((request) => ({ method: request.method, path: new URL(request.url).pathname, body: request.body }))

type Frame = { event?: 'hello'; data: unknown }

const encoder = new TextEncoder()

const encodeFrame = (frame: Frame): Uint8Array =>
  encoder.encode(`${frame.event ? `event: ${frame.event}\n` : ''}data: ${JSON.stringify(frame.data)}\n\n`)

function reply(status: number, body: unknown): Response {
  if (body === undefined) return new Response(null, { status })
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

/** The request's body text, or null when it has none; only a Request's body has to be awaited. */
function bodyText(input: RequestInfo | URL, init?: RequestInit): string | Promise<string> | null {
  if (typeof init?.body === 'string') return init.body
  if (input instanceof Request && input.body !== null) return input.clone().text()
  return null
}

const parseBody = (text: string | null): unknown =>
  text === null || text === '' ? undefined : JSON.parse(text)

/** The parts of a fetch call the fake needs, whether it got a Request (RTK Query) or a URL and init. */
function describeCall(
  input: RequestInfo | URL,
  init?: RequestInit
): Omit<CoreRequest, 'body'> & { signal: AbortSignal | null } {
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

/** What core answers the window's writes when a test scripts nothing else. */
const defaultWrites: { method: string; path: RegExp; status: number; body?: unknown }[] = [
  { method: 'POST', path: /^\/api\/models\/[^/]+\/load$/, status: 200, body: { status: 'ready' } },
  { method: 'POST', path: /^\/api\/models\/[^/]+\/unload$/, status: 202, body: { status: 'stopped' } },
  { method: 'POST', path: /^\/api\/downloads$/, status: 202, body: { status: 'accepted' } },
  { method: 'DELETE', path: /^\/api\/downloads\/[^/]+$/, status: 202, body: { status: 'accepted' } },
  { method: 'POST', path: /^\/api\/downloads\/[^/]+\/resume$/, status: 202, body: { status: 'accepted' } },
  { method: 'POST', path: /^\/api\/catalog\/[^/]+\/remove$/, status: 204 }
]

export function createFakeCoreHttp(): FakeCoreHttp {
  let models: ModelInfo[] = []
  let downloads: DownloadItem[] = []
  // core's defaults at rev 1 until a test sets something else.
  const config = new Map<string, ConfigEntry>([
    ['engine.llamaserver', { rev: 1, value: { ...defaultEngineSettings } }],
    ['provider.llamacpp', { rev: 1, value: { ...defaultLlamacppSettings } }]
  ])
  const handlers = new Map<string, Handler>()
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

  function putConfig(section: string, current: ConfigEntry, request: CoreRequest): Response {
    const { rev, value } = (request.body ?? {}) as { rev?: number; value?: unknown }
    if (rev !== current.rev || value === undefined) {
      return reply(409, {
        error: 'config_conflict',
        message: 'the section changed since it was read',
        current
      })
    }
    const next = { ...current, rev: current.rev + 1, value }
    config.set(section, next)
    return reply(200, next)
  }

  const fake: FakeCoreHttp = {
    requests: [],
    fit: {
      context: 32768,
      capped: false,
      fit: 'fits',
      placement: 'gpu',
      ramBytes: 0,
      vramBytes: 4 * 1024 ** 3,
      tokensPerSecond: 0,
      source: 'estimate'
    },
    hello: { log: 'log-1', head: 0, reset: false },
    fetch: async (input, init) => {
      const { signal, ...described } = describeCall(input, init)
      // Awaiting only when there is a body keeps a GET as quick as core's other answers (the stream tests count turns).
      const text = bodyText(input, init)
      const call: CoreRequest = {
        ...described,
        body: parseBody(typeof text === 'string' || text === null ? text : await text)
      }
      fake.requests.push(call)
      if (signal?.aborted) throw new DOMException('The request was aborted', 'AbortError')
      const path = new URL(call.url).pathname
      const handler = handlers.get(`${call.method} ${path}`)
      if (handler) {
        const answer = handler(call)
        return reply(answer.status ?? 200, answer.body)
      }
      if (call.method === 'GET' && /^\/api\/models\/[^/]+\/fit$/.test(path)) return reply(200, fake.fit)
      if (call.method === 'GET' && path === '/api/events') return openStream(signal)
      // The sidebar always asks for the chat list: no chats unless a test answers it.
      if (call.method === 'GET' && path === '/api/chats') return reply(200, { seq: 0, chats: [] })
      const section = path.startsWith('/api/config/') ? path.slice('/api/config/'.length) : ''
      const entry = config.get(section)
      if (entry && call.method === 'GET') return reply(200, entry)
      if (entry && call.method === 'PUT') return putConfig(section, entry, call)
      const write = defaultWrites.find((route) => route.method === call.method && route.path.test(path))
      if (write) return reply(write.status, write.body)
      return reply(404, { error: 'not_found', message: `no route for ${call.method} ${path}` })
    },
    answer: (path, body, options = {}) => {
      const status = options.status ?? 200
      fake.respond(options.method ?? 'GET', path, () => ({ status, body }))
    },
    respond: (method, path, handler) => {
      handlers.set(`${method.toUpperCase()} ${path}`, handler)
    },
    setConfig: (section, entry) => {
      config.set(section, entry)
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
