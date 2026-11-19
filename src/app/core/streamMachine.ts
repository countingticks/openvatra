// The window's event stream as a pure state machine: inputs in, a new state and the effects to run out. stream.ts
// runs the effects; keeping the rules here makes the reconnect, bookmark and cache decisions testable on their own.
import type { Event, Hello } from './generated'

/** Where the window is in core's log: the log's id and the last durable seq seen. */
export interface Bookmark {
  log: string | null
  seq: number | null
}

export type StreamState =
  | { name: 'idle'; bookmark: Bookmark }
  | { name: 'connecting'; bookmark: Bookmark; attempt: number }
  | { name: 'live'; bookmark: Bookmark }
  | { name: 'waiting'; bookmark: Bookmark; attempt: number }

export type StreamInput =
  | { type: 'connected' } // a connection appeared or changed (new port or token)
  | { type: 'disconnected' } // core is not ready
  | { type: 'hello'; hello: Hello }
  | { type: 'event'; event: Event }
  | { type: 'ended' } // the response ended or failed, not by an abort
  | { type: 'retry' } // the wait is over

export type StreamEffect =
  | { type: 'connect'; after: number | null; log: string | null }
  | { type: 'abort' }
  | { type: 'wait'; ms: number }
  | { type: 'invalidateAll' }
  | { type: 'apply'; event: Event }

export const retryDelaysMs: readonly number[] = [500, 1000, 2000, 5000]
const lastRetryDelayMs = 5000

export const initialStreamState: StreamState = { name: 'idle', bookmark: { log: null, seq: null } }

interface Step {
  state: StreamState
  effects: StreamEffect[]
}

const connectTo = (bookmark: Bookmark): StreamEffect => ({
  type: 'connect',
  after: bookmark.seq,
  log: bookmark.log
})

function receiveHello(bookmark: Bookmark, hello: Hello): { bookmark: Bookmark; effects: StreamEffect[] } {
  const logChanged = bookmark.log !== null && bookmark.log !== hello.log
  // Another log, or a bookmark past its head: what the cache holds may be from a world that no longer exists.
  if (hello.reset || logChanged) {
    return { bookmark: { log: hello.log, seq: hello.head }, effects: [{ type: 'invalidateAll' }] }
  }
  return { bookmark: { log: hello.log, seq: bookmark.seq ?? hello.head }, effects: [] }
}

function receiveEvent(bookmark: Bookmark, event: Event): Bookmark {
  // Retained events carry no seq and are not in the log, so they never move the bookmark.
  if (event.seq === undefined) return bookmark
  if (bookmark.seq !== null && event.seq <= bookmark.seq) return bookmark
  return { ...bookmark, seq: event.seq }
}

export function transition(state: StreamState, input: StreamInput): Step {
  const { bookmark } = state
  const abortIfOpen: StreamEffect[] = state.name === 'idle' ? [] : [{ type: 'abort' }]

  switch (input.type) {
    case 'connected':
      // A new core run (or new token): the old request is useless, and anything cached may be stale.
      return {
        state: { name: 'connecting', bookmark, attempt: 0 },
        effects: [...abortIfOpen, { type: 'invalidateAll' }, connectTo(bookmark)]
      }
    case 'disconnected':
      return { state: { name: 'idle', bookmark }, effects: abortIfOpen }
    case 'hello': {
      if (state.name !== 'connecting') break
      const next = receiveHello(bookmark, input.hello)
      return { state: { name: 'live', bookmark: next.bookmark }, effects: next.effects }
    }
    case 'event':
      if (state.name !== 'connecting' && state.name !== 'live') break
      return {
        state: { ...state, bookmark: receiveEvent(bookmark, input.event) },
        effects: [{ type: 'apply', event: input.event }]
      }
    case 'ended': {
      if (state.name !== 'connecting' && state.name !== 'live') break
      const attempt = (state.name === 'connecting' ? state.attempt : 0) + 1
      return {
        state: { name: 'waiting', bookmark, attempt },
        effects: [{ type: 'wait', ms: retryDelaysMs[attempt - 1] ?? lastRetryDelayMs }]
      }
    }
    case 'retry':
      if (state.name !== 'waiting') break
      return {
        state: { name: 'connecting', bookmark, attempt: state.attempt },
        effects: [connectTo(bookmark)]
      }
  }
  // An input that no longer applies (a late end, a retry after reconnecting): nothing changes.
  return { state, effects: [] }
}
