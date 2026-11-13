import { describe, expect, it } from 'vitest'
import type { Event, Hello } from '@renderer/core/generated'
import {
  initialStreamState,
  transition,
  type StreamEffect,
  type StreamInput,
  type StreamState
} from '@renderer/core/streamMachine'

const hello = (overrides: Partial<Hello> = {}): StreamInput => ({
  type: 'hello',
  hello: { log: 'log-1', head: 10, reset: false, ...overrides }
})

const configChanged = (seq: number): Event => ({
  seq,
  time: 1,
  stream: 'system',
  type: 'config.changed',
  v: 1,
  data: { section: 'models', rev: 2 }
})

const modelState: Event = {
  time: 1,
  stream: 'system',
  type: 'model.state',
  v: 1,
  data: { models: [] }
}

/** Runs inputs from a state; returns the final state and the effects of the last input. */
function run(
  inputs: StreamInput[],
  from: StreamState = initialStreamState
): { state: StreamState; effects: StreamEffect[] } {
  let step = { state: from, effects: [] as StreamEffect[] }
  for (const input of inputs) step = transition(step.state, input)
  return step
}

const connected: StreamInput = { type: 'connected' }
const ended: StreamInput = { type: 'ended' }
const retry: StreamInput = { type: 'retry' }

describe('streamMachine', () => {
  it('connects the first time with no bookmark and invalidates everything', () => {
    const { state, effects } = run([connected])

    expect(state).toEqual({ name: 'connecting', bookmark: { log: null, seq: null }, attempt: 0 })
    expect(effects).toEqual([{ type: 'invalidateAll' }, { type: 'connect', after: null, log: null }])
  })

  it('takes the head as seq from the first hello, and a later hello with the same log keeps it', () => {
    const first = run([connected, hello({ head: 10 })])
    expect(first.state).toEqual({ name: 'live', bookmark: { log: 'log-1', seq: 10 } })
    expect(first.effects).toEqual([])

    const later = run([ended, retry, hello({ head: 20 })], first.state)
    expect(later.state.bookmark).toEqual({ log: 'log-1', seq: 10 })
    expect(later.effects).toEqual([])
  })

  it.each([
    ['reset', hello({ head: 3, reset: true })],
    ['another log id', hello({ log: 'log-2', head: 3 })]
  ])('a hello with %s invalidates everything and takes the head', (_name, second) => {
    const before = run([connected, hello({ head: 10 }), ended, retry]).state

    const { state, effects } = run([second], before)

    expect(effects).toEqual([{ type: 'invalidateAll' }])
    expect(state.bookmark.seq).toBe(3)
  })

  it('moves the seq forward on a durable event, not on a retained one, and never back', () => {
    const live = run([connected, hello({ head: 10 })]).state

    const forward = run([{ type: 'event', event: configChanged(12) }], live)
    expect(forward.effects).toEqual([{ type: 'apply', event: configChanged(12) }])
    expect(forward.state.bookmark.seq).toBe(12)

    const retained = run([{ type: 'event', event: modelState }], forward.state)
    expect(retained.effects).toEqual([{ type: 'apply', event: modelState }])
    expect(retained.state.bookmark.seq).toBe(12)

    const older = run([{ type: 'event', event: configChanged(11) }], forward.state)
    expect(older.state.bookmark.seq).toBe(12)
  })

  it('waits 0.5, 1, 2, 5 and 5 s across five failures without a hello, and a hello starts over', () => {
    let state = run([connected]).state
    const waits: StreamEffect[] = []
    for (let failure = 0; failure < 5; failure++) {
      const step = transition(state, ended)
      waits.push(...step.effects)
      state = transition(step.state, retry).state
    }
    expect(waits).toEqual([500, 1000, 2000, 5000, 5000].map((ms) => ({ type: 'wait', ms })))

    const afterHello = run([hello(), ended], state)
    expect(afterHello.effects).toEqual([{ type: 'wait', ms: 500 }])
  })

  it('a connection change while live aborts, invalidates everything and reconnects with the bookmark', () => {
    const live = run([connected, hello({ head: 10 })]).state

    const { state, effects } = run([connected], live)

    expect(state).toEqual({ name: 'connecting', bookmark: { log: 'log-1', seq: 10 }, attempt: 0 })
    expect(effects).toEqual([
      { type: 'abort' },
      { type: 'invalidateAll' },
      { type: 'connect', after: 10, log: 'log-1' }
    ])
  })

  it('a disconnect keeps the bookmark, and the next connection sends it', () => {
    const live = run([connected, hello({ head: 10 })]).state

    const down = run([{ type: 'disconnected' }], live)
    expect(down.state).toEqual({ name: 'idle', bookmark: { log: 'log-1', seq: 10 } })
    expect(down.effects).toEqual([{ type: 'abort' }])

    const up = run([connected], down.state)
    expect(up.effects).toEqual([{ type: 'invalidateAll' }, { type: 'connect', after: 10, log: 'log-1' }])
  })

  it.each([
    ['ended while idle', initialStreamState, ended],
    ['retry while live', run([connected, hello()]).state, retry],
    ['hello while waiting', run([connected, ended]).state, hello()]
  ])('a stale input (%s) changes nothing', (_name, from, input) => {
    expect(transition(from, input)).toEqual({ state: from, effects: [] })
  })
})
