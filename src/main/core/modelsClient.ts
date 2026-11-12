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
  log: { warn: (message: string, error?: unknown) => void }
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
  log
}: ModelsClientOptions): ModelsClient {
  let models: ModelInfo[] = []
  let downloads: DownloadItem[] = []
  let stream: AbortController | null = null
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined

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
      const response = await request('/api/events', { signal: controller.signal })
      if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`)
      const decoder = new TextDecoder()
      let buffer = ''
      for await (const chunk of response.body) {
        buffer += decoder.decode(chunk, { stream: true })
        const { events, rest } = takeSseEvents(buffer)
        buffer = rest
        for (const { event, data } of events) {
          if (event === 'state') receive(data)
          else if (event === 'downloads') receiveDownloads(data)
        }
      }
    } catch (error) {
      if (!controller.signal.aborted) log.warn('core: the model event stream failed', error)
    }
  }

  function receive(data: string): void {
    try {
      const body: unknown = JSON.parse(data)
      const list = (body as { models?: unknown } | null)?.models
      if (isModelList(list)) set(list)
      else log.warn('core: ignored a malformed model list')
    } catch (error) {
      log.warn('core: ignored a model event that is not JSON', error)
    }
  }

  function setDownloads(next: DownloadItem[]): void {
    downloads = next
    onDownloads(next)
  }

  function receiveDownloads(data: string): void {
    try {
      const items = (JSON.parse(data) as { items?: unknown } | null)?.items
      if (isDownloadList(items)) setDownloads(items)
      else log.warn('core: ignored a malformed download list')
    } catch (error) {
      log.warn('core: ignored a download event that is not JSON', error)
    }
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
