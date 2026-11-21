import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Event, RunSnapshot, SchedState, Transcript } from '@app/core/generated'
import {
  answerState,
  applyRunEvent,
  chatIdOf,
  emptyTranscript,
  estimateTokens,
  runIdOf,
  runView,
  waitingLine,
  type LiveAnswer,
  type TranscriptEntry
} from '@app/features/runs'

/** One of core's replay fixtures, numbered as the log would: line i gets seq i + 1. */
function fixture(name: string): Event[] {
  return readFileSync(resolve('core/internal/run/testdata', `${name}.jsonl`), 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line, i) => ({ ...(JSON.parse(line) as Event), seq: i + 1, v: 1, time: 0 }))
}

const fold = (events: Event[], from: Transcript = emptyTranscript): Transcript =>
  events.reduce(applyRunEvent, from)

/** Entries reduced to what a reader sees: kind and its words. */
function shown(entries: TranscriptEntry[]): string[] {
  return entries.map((entry) => {
    switch (entry.kind) {
      case 'input':
        return `input ${entry.text.slice(0, 2)}${entry.queued ? ' (queued)' : ''}`
      case 'answer':
        return `answer ${entry.parts.map((part) => part.text).join('|')}`
      case 'notice':
        return entry.notice === 'failed' ? `failed ${entry.error.code}` : 'interrupted'
      default:
        return entry.kind
    }
  })
}

const run = (overrides: Partial<RunSnapshot> = {}): RunSnapshot => ({
  id: 'r1',
  chatId: 'c1',
  state: 'running',
  profile: 'chat',
  model: 'tiny',
  seq: 1,
  error: null,
  ...overrides
})

describe('runView over core replay fixtures', () => {
  it('send_done: the input, then the answer with its reasoning; nothing live', () => {
    const view = runView(fold(fixture('send_done')))

    expect(view.entries).toMatchObject([
      { kind: 'input', text: 'hi', queued: false },
      {
        kind: 'answer',
        parts: [
          { kind: 'reasoning', text: 'think' },
          { kind: 'text', text: 'Hello' }
        ]
      }
    ])
    expect(view.entries.some((entry) => entry.kind === 'live')).toBe(false)
    expect(view.activeRun).toBeNull()
  })

  it('queued_input: each answer follows its own input, though "two" came before "one!"', () => {
    const view = runView(fold(fixture('queued_input')))

    expect(shown(view.entries)).toEqual(['input on', 'answer one!', 'input tw', 'answer two!'])
  })

  it('stop_partial: the answer is partial, not failed, with no notice', () => {
    const view = runView(fold(fixture('stop_partial')))

    expect(view.entries).toMatchObject([{ kind: 'input' }, { kind: 'answer', partial: true, failed: false }])
    expect(view.entries).toHaveLength(2)
  })

  it('fail_midway: the cut-off answer is failed and a failed notice follows', () => {
    const view = runView(fold(fixture('fail_midway')))

    expect(view.entries).toMatchObject([
      { kind: 'input' },
      { kind: 'answer', partial: true, failed: true },
      { kind: 'notice', notice: 'failed', error: { code: 'backend_failed' } }
    ])
  })

  it('interrupted: the input, then an interrupted notice', () => {
    const view = runView(fold(fixture('interrupted')))

    expect(shown(view.entries)).toEqual(['input hi', 'interrupted'])
    expect(view.activeRun?.state).toBe('interrupted')
  })

  it("compact: run4 shows its summary before its input, and the summary sets the context's use", () => {
    const events = fixture('compact')
    const view = runView(fold(events))

    expect(shown(view.entries.filter((entry) => entry.runId === 'run4'))).toEqual([
      'summary',
      'input q4',
      'answer a4'
    ])
    const compaction = events.findIndex((event) => event.type === 'compaction.completed')
    expect(fold(events.slice(0, compaction + 1)).context.used).toBe(819)
  })

  it('overflow_fail: run3 ends with a failed notice and has no answer', () => {
    const view = runView(fold(fixture('overflow_fail')))

    expect(shown(view.entries.filter((entry) => entry.runId === 'run3'))).toEqual([
      'summary',
      'input q3',
      'failed context_exceeded'
    ])
  })

  it('folding a fixture twice gives the same transcript as once', () => {
    const events = fixture('queued_input')

    expect(fold([...events, ...events])).toEqual(fold(events))
  })
})

describe('runView', () => {
  it('puts the live answer under the first unanswered input of the running run, and queues the rest', () => {
    const transcript: Transcript = {
      seq: 4,
      items: [
        { kind: 'input', seq: 1, runId: 'r1', text: 'A' },
        { kind: 'answer', seq: 2, runId: 'r1', parts: [{ kind: 'text', text: 'a' }] },
        { kind: 'input', seq: 3, runId: 'r1', text: 'B' },
        { kind: 'input', seq: 4, runId: 'r1', text: 'C' }
      ],
      runs: [run()],
      activeRun: run(),
      context: { used: 0, size: 0 }
    }

    expect(shown(runView(transcript).entries)).toEqual([
      'input A',
      'answer a',
      'input B',
      'live',
      'input C (queued)'
    ])
  })

  it('regenerate: the retracted run leaves the transcript and the new run shows', () => {
    const view = runView(fold(fixture('regenerate')))

    expect(shown(view.entries)).toEqual(['input q1', 'answer a1', 'input q2', 'answer a2 again'])
    expect(view.entries.map((entry) => entry.runId)).toEqual(['run1', 'run1', 'run3', 'run3'])
  })

  it('title: after the answer and before run.finished there is no live entry', () => {
    const events = fixture('title')
    const beforeFinish = events.slice(
      0,
      events.findIndex((e) => e.type === 'run.finished')
    )
    const view = runView(fold(beforeFinish))

    expect(view.activeRun).not.toBeNull()
    expect(shown(view.entries)).toEqual(['input Ho', 'answer Lifetimes are scopes.'])
  })
})

describe('applyRunEvent', () => {
  const started: Transcript = {
    seq: 3,
    items: [
      { kind: 'input', seq: 2, runId: 'r1', text: 'A' },
      { kind: 'answer', seq: 3, runId: 'r1', parts: [{ kind: 'text', text: 'a' }], partial: false }
    ],
    runs: [run()],
    activeRun: run(),
    context: { used: 0, size: 0 }
  }

  it('a failed run.finished after a complete answer leaves that answer not failed', () => {
    const failed = applyRunEvent(started, {
      type: 'run.finished',
      stream: 'run:r1',
      seq: 4,
      v: 1,
      time: 0,
      data: { chatId: 'c1', state: 'failed', error: { code: 'backend_failed', message: 'It stopped.' } }
    })

    expect(runView(failed).entries).toMatchObject([
      { kind: 'input' },
      { kind: 'answer', failed: false },
      { kind: 'notice', notice: 'failed' }
    ])
  })

  it('a turn.retracted at or below the transcript seq changes nothing', () => {
    const stale: Event = {
      type: 'turn.retracted',
      stream: 'chat:c1',
      seq: 3,
      v: 1,
      time: 0,
      data: { runId: 'r1' }
    }

    expect(applyRunEvent(started, stale)).toBe(started)
  })

  it('an ephemeral message.delta returns the very same object', () => {
    const delta: Event = { type: 'message.delta', stream: 'run:r1', v: 1, time: 0, data: { text: 'x', n: 1 } }

    expect(applyRunEvent(started, delta)).toBe(started)
  })
})

describe('event routing', () => {
  const event = (type: string, stream: string, data: object): Event =>
    ({ type, stream, seq: 1, v: 1, time: 0, data }) as Event

  it.each([
    [event('run.queued', 'run:r1', { chatId: 'c1' }), 'c1', 'r1'],
    [event('input.received', 'run:r1', { chatId: 'c1' }), 'c1', 'r1'],
    [event('message.completed', 'run:r1', { chatId: 'c1' }), 'c1', 'r1'],
    [event('compaction.completed', 'run:r1', { chatId: 'c1' }), 'c1', 'r1'],
    [event('message.delta', 'run:r1', { text: 'x', n: 1 }), null, 'r1'],
    [event('chat.model', 'chat:c2', { model: 'tiny' }), 'c2', null],
    [event('turn.retracted', 'chat:c2', { runId: 'r1' }), 'c2', null],
    [event('chat.deleted', 'system', { chatId: 'c3' }), 'c3', null],
    [event('model.state', 'system', { models: [] }), null, null]
  ])('%#: %o belongs to chat %s, run %s', (e, chat, runId) => {
    expect(chatIdOf(e)).toBe(chat)
    expect(runIdOf(e)).toBe(runId)
  })

  it('estimates tokens as core does', () => {
    expect(estimateTokens('abcdefg')).toBe(2)
  })
})

describe('answerState and waitingLine', () => {
  const live = (text: string, reasoning: string): LiveAnswer => ({ text, reasoning, n: 1, reasoningAt: null })
  const waiting: SchedState = { holder: 'r9', waiting: [{ runId: 'r1', why: 'another chat is answering' }] }

  it.each<
    [string, RunSnapshot | null, LiveAnswer | undefined, SchedState | null, boolean, string, string | null]
  >([
    ['no run', null, undefined, null, false, 'idle', null],
    ['interrupted', run({ state: 'interrupted' }), undefined, null, false, 'idle', null],
    [
      'queued, waiting for the lease',
      run({ state: 'queued' }),
      undefined,
      waiting,
      false,
      'thinking',
      'Waiting: another chat is answering'
    ],
    ['running, model loading', run(), undefined, null, true, 'thinking', 'Loading tiny…'],
    ['running, reasoning only', run(), live('', 'hmm'), null, true, 'thinking', null],
    ['running, text', run(), live('Hi', ''), null, false, 'streaming', null]
  ])('%s', (_name, activeRun, answer, sched, modelLoading, state, line) => {
    expect(answerState(activeRun, answer)).toBe(state)
    expect(waitingLine({ activeRun, live: answer, sched, model: 'tiny', modelLoading })).toBe(line)
  })

  it('a running run without a live entry is idle', () => {
    expect(answerState(run(), live('Hi', ''), false)).toBe('idle')
    expect(answerState(run(), undefined, false)).toBe('idle')
  })
})
