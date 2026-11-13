// Runs streamMachine for this window: one GET /api/events?stream=system while core is reachable, its frames fed to
// the machine and the machine's effects carried out against the network, the timers and the cache.
import type { CoreConnection } from '../../../shared/core'
import type { AppDispatch, RootState } from '../store/store'
import { selectConnection } from './connectionSlice'
import type { Event, Hello } from './generated'
import { takeFrames, type SseFrame } from './sse'
import {
  initialStreamState,
  transition,
  type StreamEffect,
  type StreamInput,
  type StreamState
} from './streamMachine'
import { applyEvent, invalidateAll } from './streamSync'

export interface StreamDeps {
  dispatch: AppDispatch
  getState: () => RootState
  subscribe: (listener: () => void) => () => void
}

function isHello(value: unknown): value is Hello {
  if (typeof value !== 'object' || value === null) return false
  const { log, head, reset } = value as Record<string, unknown>
  return typeof log === 'string' && typeof head === 'number' && typeof reset === 'boolean'
}

function isEvent(value: unknown): value is Event {
  return (
    typeof value === 'object' && value !== null && typeof (value as Record<string, unknown>).type === 'string'
  )
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

function eventsUrl(connection: CoreConnection, after: number | null, log: string | null): string {
  const query = ['stream=system']
  if (after !== null) query.push(`after=${encodeURIComponent(String(after))}`)
  if (log !== null) query.push(`log=${encodeURIComponent(log)}`)
  return `${connection.baseUrl}/api/events?${query.join('&')}`
}

/** Runs streamMachine for this window: one GET /api/events?stream=system while a connection exists. Returns stop. */
export function followCoreStream({ dispatch, getState, subscribe }: StreamDeps): () => void {
  let state: StreamState = initialStreamState
  let request: AbortController | null = null
  let timer: ReturnType<typeof setTimeout> | undefined
  let seen: CoreConnection | null = null
  let stopped = false

  function feed(input: StreamInput): void {
    if (stopped) return
    const step = transition(state, input)
    state = step.state
    step.effects.forEach(run)
  }

  function run(effect: StreamEffect): void {
    switch (effect.type) {
      case 'connect':
        void open(effect.after, effect.log)
        return
      case 'abort':
        request?.abort()
        request = null
        clearTimeout(timer)
        timer = undefined
        return
      case 'wait':
        timer = setTimeout(() => {
          timer = undefined
          feed({ type: 'retry' })
        }, effect.ms)
        return
      case 'invalidateAll':
        invalidateAll(dispatch)
        return
      case 'apply':
        applyEvent(effect.event, dispatch, getState)
        return
    }
  }

  async function open(after: number | null, log: string | null): Promise<void> {
    const connection = selectConnection(getState())
    if (connection === null) return
    const mine = new AbortController()
    request = mine
    // A request that was aborted or replaced must not feed the machine any more.
    const current = (): boolean => request === mine && !mine.signal.aborted
    let warned = false

    const receive = (frame: SseFrame): void => {
      if (frame.event !== 'hello' && frame.event !== 'message') return
      const value = parseJson(frame.data)
      if (frame.event === 'hello' && isHello(value)) feed({ type: 'hello', hello: value })
      else if (frame.event === 'message' && isEvent(value)) feed({ type: 'event', event: value })
      else if (!warned) {
        // Once per stream: a core that keeps sending bad frames should not flood the console.
        warned = true
        console.warn('core: skipped a malformed event frame')
      }
    }

    try {
      // The token goes in a header, never in the URL, where it could end up in a log.
      const response = await globalThis.fetch(eventsUrl(connection, after, log), {
        headers: { Authorization: `Bearer ${connection.token}` },
        signal: mine.signal
      })
      if (!current()) return
      if (!response.ok || response.body === null) {
        feed({ type: 'ended' })
        return
      }
      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      for (;;) {
        const { done, value } = await reader.read()
        if (!current()) return
        if (done) break
        const taken = takeFrames(buffer + decoder.decode(value, { stream: true }))
        buffer = taken.rest
        for (const frame of taken.frames) {
          receive(frame)
          if (!current()) return
        }
      }
      feed({ type: 'ended' })
    } catch {
      // Only a failure of the live request counts; an abort is the machine's own doing.
      if (current()) feed({ type: 'ended' })
    }
  }

  function follow(): void {
    const next = selectConnection(getState())
    if (next === seen) return
    seen = next
    feed(next === null ? { type: 'disconnected' } : { type: 'connected' })
  }

  const unsubscribe = subscribe(follow)
  follow()

  return () => {
    feed({ type: 'disconnected' })
    stopped = true
    unsubscribe()
  }
}
