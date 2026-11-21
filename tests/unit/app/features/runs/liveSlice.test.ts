import { describe, expect, it } from 'vitest'
import { coreEvent } from '@app/core/events'
import type { Event } from '@app/core/generated'
import { liveSlice, type LiveState } from '@app/features/runs/liveSlice'

const event = (type: string, data: object, stream = 'run:r1'): Event =>
  ({ type, stream, v: 1, time: 0, data }) as Event

const delta = (text: string, n: number, stream = 'run:r1'): Event =>
  event('message.delta', { text, n }, stream)

const fold = (events: Event[]): LiveState =>
  events.reduce((state, e) => liveSlice.reducer(state, coreEvent(e)), liveSlice.getInitialState())

describe('liveSlice', () => {
  it('appends deltas in order and drops one whose n it already has', () => {
    const state = fold([delta('Hel', 1), delta('lo', 2), delta('lo', 2)])

    expect(state.runs.r1).toMatchObject({ text: 'Hello', n: 2 })
  })

  it('a partial replaces the entry; a later delta with its n is dropped, the next one appends', () => {
    const state = fold([
      delta('He', 1),
      event('message.partial', { text: 'Hello', reasoning: 'hmm', n: 5 }),
      delta('o', 5),
      delta('!', 6)
    ])

    expect(state.runs.r1).toMatchObject({ text: 'Hello!', reasoning: 'hmm', n: 6 })
  })

  it('ignores a partial older than the entry', () => {
    const state = fold([delta('abc', 3), event('message.partial', { text: 'a', reasoning: '', n: 1 })])

    expect(state.runs.r1).toMatchObject({ text: 'abc', n: 3 })
  })

  it('drops the entry on message.completed and run.finished, and keeps runs apart', () => {
    const state = fold([delta('one', 1), delta('two', 1, 'run:r2'), delta('three', 1, 'run:r3')])
    expect(state.runs.r2.text).toBe('two')

    const done = [
      event('message.completed', { chatId: 'c1', parts: [], partial: false, model: 'm', stats: {} }),
      event('run.finished', { chatId: 'c1', state: 'done' }, 'run:r2')
    ].reduce((s, e) => liveSlice.reducer(s, coreEvent(e)), state)

    expect(Object.keys(done.runs)).toEqual(['r3'])
    expect(done.runs.r3.text).toBe('three')
  })

  it('stores sched.state and replaces it', () => {
    const first = { holder: 'r1', waiting: [{ runId: 'r2', why: 'another chat is answering' }] }
    const second = { holder: 'r2', waiting: [] }

    expect(fold([event('sched.state', first, 'system')]).sched).toEqual(first)
    expect(
      fold([event('sched.state', first, 'system'), event('sched.state', second, 'system')]).sched
    ).toEqual(second)
  })
})
