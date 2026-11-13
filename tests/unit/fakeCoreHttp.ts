// Plays core's HTTP side for the window's data layer: JSON answers per path, the write routes the window calls,
// the models config section with its rev, and /api/events streams the test pushes frames into. Stubbed in as fetch,
// so the real base query and event stream run against it.

import type { Models, ModelsEffective } from '../../src/renderer/src/core/generated'
import type { ModelInfo } from '../../src/shared/core'
import type { DownloadItem } from '../../src/shared/setup'

export interface CoreRequest {
  url: string
  method: string
  authorization: string | null
  /** The JSON-parsed request body; undefined when there is none. */
  body: unknown
}

type Handler = (request: CoreRequest) => { status?: number; body?: unknown }

export interface ModelsEntry {
  rev: number
  value: Models
  effective?: ModelsEffective
}

export interface FakeCoreHttp {
  fetch: typeof fetch
  /** JSON answer for a method and path (default method GET, status 200); unknown paths answer 404 not_found. */
  answer(path: string, body: unknown, options?: { method?: string; status?: number }): void
  /** Answers method + path with whatever handler returns; replaces the default and any earlier answer. */
  respond(method: string, path: string, handler: Handler): void
  /** Sets the entry GET /api/config/models answers and PUT compares with. */
  setConfigModels(entry: ModelsEntry): void
  /** Sends one frame to every open /api/events stream. */
  push(frame: { event?: 'hello'; data: unknown }): void
  /** Sets GET /api/models and sends model.state (retained, no seq) to open streams; new streams get it after hello. */
  setModels(models: ModelInfo[]): void
  /** Same for GET /api/downloads and download.progress. */
  setDownloads(items: DownloadItem[]): void
  /** Ends every open stream, as a core that went away. */
  endStreams(): void
  /** Every request seen. */
  requests: CoreRequest[]
  openStreams(): number
  /** The hello each new stream starts with; default { log: 'log-1', head: 0, reset: false }. */
  hello: { log: string; head: number; reset: boolean }
}

/** core's defaults for the models section (config.DefaultModels). */
export const defaultCoreModels: Readonly<Models> = {
  embeddingModel: null,
  engine: 'bundled',
  idleUnloadMinutes: 15,
  llamaServerPath: null,
  modelsDir: null,
  options: {}
}

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
  let configModels: ModelsEntry = { rev: 1, value: { ...defaultCoreModels } }
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

  function putConfigModels(request: CoreRequest): Response {
    const { rev, value } = (request.body ?? {}) as { rev?: number; value?: Models }
    if (rev !== configModels.rev || value === undefined) {
      return reply(409, {
        error: 'config_conflict',
        message: 'the section changed since it was read',
        current: configModels
      })
    }
    configModels = { ...configModels, rev: configModels.rev + 1, value }
    return reply(200, configModels)
  }

  const fake: FakeCoreHttp = {
    requests: [],
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
      if (call.method === 'GET' && path === '/api/events') return openStream(signal)
      if (call.method === 'GET' && path === '/api/config/models') return reply(200, configModels)
      if (call.method === 'PUT' && path === '/api/config/models') return putConfigModels(call)
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
    setConfigModels: (entry) => {
      configModels = entry
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
