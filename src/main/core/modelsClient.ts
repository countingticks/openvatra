// core's model endpoints, for the UI: follows core's event stream (GET /api/events) to keep the model list current
// without polling, and loads or unloads a model on request. No Electron imports, so tests need only a fake fetch.
import { isModelList, type ModelInfo } from '../../shared/core'
import { coreErrorMessage } from './coreError'
import { isDownloadList, type DownloadItem } from '../../shared/setup'

/** Wait before reopening an event stream that ended while core was still ready. */
const reconnectDelayMs = 2_000

export interface SseEvent {
  event: string
  data: string
}

/**
 * Cuts complete Server-Sent Events off the front of `buffer`. An event is a few "field: value" lines ended by a blank
 * line; a network chunk can end mid-event, so the unfinished tail comes back as `rest` for the next chunk.
 */
export function takeSseEvents(buffer: string): { events: SseEvent[]; rest: string } {
  const blocks = buffer.replace(/\r\n?/g, '\n').split('\n\n')
  const rest = blocks.pop() ?? ''
  const events = blocks.map((block) => {
    let event = 'message' // the SSE default when no "event:" line is given
    const data: string[] = []
    for (const line of block.split('\n')) {
      const colon = line.indexOf(':')
      if (colon <= 0) continue // ":" starts a comment; a line without a colon carries nothing we use
      const value = line.slice(colon + 1).replace(/^ /, '')
      if (line.startsWith('event:')) event = value
      else if (line.startsWith('data:')) data.push(value)
    }
    return { event, data: data.join('\n') }
  })
  return { events, rest }
}

export interface ModelsClientOptions {
  /** The supervisor's `request`: core's address and token stay there. */
  request: (path: string, init?: RequestInit) => Promise<Response>
  onModels: (models: ModelInfo[]) => void
  /** The whole download queue, on every change (core sends it at most 4 times a second). */
  onDownloads: (items: DownloadItem[]) => void
  /** config.changed from core: which section changed and its new rev. */
  onConfig?: (section: string, rev: number) => void
  /** core's log was replaced or the bookmark is past its head: cached config may be stale. */
  onReset?: () => void
  log: { warn: (message: string, error?: unknown) => void }
}

/** One log event as core sends it: the frame's data. */
interface Envelope {
  seq?: number
  type: string
  stream: string
  v: number
  data: unknown
}

interface Hello {
  log: string
  head: number
  reset: boolean
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isCount = (value: unknown, min: number): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= min

function parseJson(data: string): unknown {
  try {
    return JSON.parse(data)
  } catch {
    return undefined
  }
}

function parseEnvelope(data: string): Envelope | null {
  const body = parseJson(data)
  if (!isRecord(body)) return null
  const { seq, type, stream, v } = body
  if (typeof type !== 'string' || typeof stream !== 'string' || !Number.isInteger(v)) return null
  if (!('data' in body) || (seq !== undefined && !isCount(seq, 1))) return null
  return body as unknown as Envelope
}

function parseHello(data: string): Hello | null {
  const body = parseJson(data)
  if (!isRecord(body)) return null
  const { log, head, reset } = body
  if (typeof log !== 'string' || !isCount(head, 0) || typeof reset !== 'boolean') return null
  return { log, head, reset }
}

export interface ModelsClient {
  /** Follows core's events; call each time a core becomes ready. Replaces any stream already open. */
  start: () => void
  /** Stops following and empties the list; call when core stops being ready. */
  stop: () => void
  list: () => ModelInfo[]
  /** The latest download queue, for a window that opens after the last event. */
  downloads: () => DownloadItem[]
  load: (id: string) => Promise<void>
  unload: (id: string) => Promise<void>
}

export function createModelsClient({
  request,
  onModels,
  onDownloads,
  onConfig,
  onReset,
  log
}: ModelsClientOptions): ModelsClient {
  let models: ModelInfo[] = []
  let downloads: DownloadItem[] = []
  let stream: AbortController | null = null
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined
  // The bookmark: core's log id and the last durable seq seen. Kept across stop() so a restarted core sends only
  // what was missed; an app restart starts without one.
  let logId: string | null = null
  let seq: number | null = null

  function set(next: ModelInfo[]): void {
    models = next
    onModels(next)
  }

  function start(): void {
    stop()
    const controller = new AbortController()
    stream = controller
    void follow(controller).finally(() => {
      // Ended on its own (not by stop): core is still up, so try again shortly; stop() cancels that too.
      if (stream !== controller) return
      stream = null
      set([])
      setDownloads([])
      reconnectTimer = setTimeout(start, reconnectDelayMs)
    })
  }

  async function follow(controller: AbortController): Promise<void> {
    try {
      let path = '/api/events?stream=system'
      if (seq !== null) path += `&after=${encodeURIComponent(String(seq))}`
      if (logId) path += `&log=${encodeURIComponent(logId)}`
      const response = await request(path, { signal: controller.signal })
      if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`)
      const decoder = new TextDecoder()
      let buffer = ''
      let warnedMalformed = false
      const malformed = (): void => {
        if (!warnedMalformed) log.warn('core: ignored a malformed event')
        warnedMalformed = true
      }
      for await (const chunk of response.body) {
        buffer += decoder.decode(chunk, { stream: true })
        const { events, rest } = takeSseEvents(buffer)
        buffer = rest
        for (const { event, data } of events) {
          if (data === '') continue // a keepalive comment: SSE dispatches nothing without data
          if (event === 'hello') {
            const hello = parseHello(data)
            if (hello) receiveHello(hello)
            else malformed()
          } else if (event === 'message') {
            const envelope = parseEnvelope(data)
            if (envelope) receiveEnvelope(envelope)
            else malformed()
          }
        }
      }
    } catch (error) {
      if (!controller.signal.aborted) log.warn('core: the model event stream failed', error)
    }
  }

  function receiveHello(hello: Hello): void {
    const logChanged = logId !== null && hello.log !== logId
    if (hello.reset || logChanged) onReset?.()
    if (seq === null || hello.reset || logChanged) seq = hello.head
    logId = hello.log
  }

  function receiveEnvelope(envelope: Envelope): void {
    if (envelope.seq !== undefined && (seq === null || envelope.seq > seq)) seq = envelope.seq
    if (envelope.type === 'model.state') receive(envelope.data)
    else if (envelope.type === 'download.progress') receiveDownloads(envelope.data)
    else if (envelope.type === 'config.changed') receiveConfig(envelope.data)
  }

  function receive(data: unknown): void {
    const list = isRecord(data) ? data.models : undefined
    if (isModelList(list)) set(list)
    else log.warn('core: ignored a malformed model list')
  }

  function setDownloads(next: DownloadItem[]): void {
    downloads = next
    onDownloads(next)
  }

  function receiveDownloads(data: unknown): void {
    const items = isRecord(data) ? data.items : undefined
    if (isDownloadList(items)) setDownloads(items)
    else log.warn('core: ignored a malformed download list')
  }

  function receiveConfig(data: unknown): void {
    const { section, rev } = isRecord(data) ? data : {}
    if (typeof section !== 'string' || typeof rev !== 'number' || !Number.isInteger(rev)) {
      log.warn('core: ignored a malformed config event')
      return
    }
    onConfig?.(section, rev)
  }

  function stop(): void {
    clearTimeout(reconnectTimer)
    const controller = stream
    stream = null
    controller?.abort()
    if (models.length > 0) set([])
    if (downloads.length > 0) setDownloads([])
  }

  /** POSTs to a model's endpoint; a failure rejects with core's own short message. */
  async function act(id: string, action: 'load' | 'unload'): Promise<void> {
    const response = await request(`/api/models/${encodeURIComponent(id)}/${action}`, { method: 'POST' })
    if (response.ok) return
    throw new Error(await coreErrorMessage(response))
  }

  return {
    start,
    stop,
    list: () => models,
    downloads: () => downloads,
    load: (id) => act(id, 'load'),
    unload: (id) => act(id, 'unload')
  }
}
