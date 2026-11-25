// A chat's transcript as the window shows it, and how core's run events change it. Pure: no React, no Redux.
import type {
  Event,
  MessagePart,
  MessageStats,
  RunError,
  RunSnapshot,
  SchedState,
  Transcript,
  TranscriptItem
} from '@app/core/generated'

export type TranscriptEntry =
  | {
      kind: 'input'
      key: string
      runId: string
      seq: number
      time: number
      text: string
      quotes: string[]
      queued: boolean
    }
  | {
      kind: 'answer'
      key: string
      runId: string
      seq: number
      time: number
      parts: MessagePart[]
      stats: MessageStats | null
      partial: boolean
      failed: boolean
    }
  | { kind: 'summary'; key: string; runId: string; seq: number }
  | { kind: 'live'; key: string; runId: string }
  | { kind: 'notice'; key: string; runId: string; notice: 'interrupted' }
  | { kind: 'notice'; key: string; runId: string; notice: 'failed'; error: RunError }

export interface RunView {
  seq: number
  entries: TranscriptEntry[]
  activeRun: RunSnapshot | null
}

/** Live text of one answering run (liveSlice). `reasoningAt`: Date.now() at its first reasoning delta. */
export interface LiveAnswer {
  text: string
  reasoning: string
  n: number
  reasoningAt: number | null
}

export type AnswerState = 'idle' | 'thinking' | 'streaming'

export const emptyTranscript: Transcript = {
  seq: 0,
  items: [],
  runs: [],
  context: { used: 0, size: 0, parts: { system: 0, messages: 0, messageCount: 0, search: 0, files: 0 } }
}

const inputEntry = (item: TranscriptItem, queued: boolean): TranscriptEntry => ({
  kind: 'input',
  key: `seq:${item.seq}`,
  runId: item.runId,
  seq: item.seq,
  time: item.time,
  text: item.text ?? '',
  quotes: item.quotes?.map((q) => q.text) ?? [],
  queued
})

const answerEntry = (item: TranscriptItem): TranscriptEntry => ({
  kind: 'answer',
  key: `seq:${item.seq}`,
  runId: item.runId,
  seq: item.seq,
  time: item.time,
  parts: item.parts ?? [],
  stats: item.stats ?? null,
  partial: item.partial ?? false,
  failed: item.failed ?? false
})

/** One run's entries: its summaries, then each input followed by its answer (the n-th answer is the n-th input's). */
function runEntries(
  runId: string,
  items: TranscriptItem[],
  active: RunSnapshot | null,
  run: RunSnapshot | undefined
): TranscriptEntry[] {
  const summaries = items.filter((item) => item.kind === 'summary').sort((a, b) => a.seq - b.seq)
  const inputs = items.filter((item) => item.kind === 'input')
  const answers = items.filter((item) => item.kind === 'answer')
  const answering = active?.id === runId && (active.state === 'queued' || active.state === 'running')
  const interrupted = active?.id === runId && active.state === 'interrupted'

  const out: TranscriptEntry[] = summaries.map((item) => ({
    kind: 'summary',
    key: `seq:${item.seq}`,
    runId,
    seq: item.seq
  }))
  let waiting = false
  inputs.forEach((input, i) => {
    out.push(inputEntry(input, waiting))
    if (i < answers.length) {
      out.push(answerEntry(answers[i]))
    } else if ((answering || interrupted) && !waiting) {
      // The input being answered: the live answer goes under it, the inputs after it wait their turn.
      waiting = true
      if (answering) out.push({ kind: 'live', key: `live:${runId}`, runId })
    }
  })
  answers.slice(inputs.length).forEach((answer) => out.push(answerEntry(answer)))
  // Before its input arrives the run shows a live answer; once every input is answered the run is only
  // finishing (a title step), so nothing live follows the last answer.
  if (answering && inputs.length === 0) out.push({ kind: 'live', key: `live:${runId}`, runId })
  if (interrupted) out.push({ kind: 'notice', key: `notice:${runId}`, runId, notice: 'interrupted' })
  if (run?.state === 'failed' && run.error) {
    out.push({ kind: 'notice', key: `notice:${runId}`, runId, notice: 'failed', error: run.error })
  }
  return out
}

/** Orders a transcript as the engine reads it (its `conversation`), with the live answer and notices in place. */
export function runView(transcript: Transcript): RunView {
  const activeRun = transcript.activeRun ?? null
  const byRun = new Map<string, TranscriptItem[]>()
  for (const item of transcript.items) {
    const list = byRun.get(item.runId)
    if (list) list.push(item)
    else byRun.set(item.runId, [item])
  }
  const runs = new Map(transcript.runs.map((run) => [run.id, run]))
  const entries = [...byRun].flatMap(([runId, items]) => runEntries(runId, items, activeRun, runs.get(runId)))
  return { seq: transcript.seq, entries, activeRun }
}

type RunState = RunSnapshot['state']

/** Whether core counts an item as a message of the context: an input, or an answer with text that did not fail. */
function counted(item: TranscriptItem): boolean {
  if (item.kind === 'input') return true
  return (
    item.kind === 'answer' &&
    !item.failed &&
    (item.parts ?? []).some((part) => part.kind === 'text' && part.text !== '')
  )
}

/** The transcript's context with its message count changed by `delta` (never below 0) or set. */
function withMessageCount(context: Transcript['context'], count: number): Transcript['context'] {
  return { ...context, parts: { ...context.parts, messageCount: Math.max(0, count) } }
}

/** The transcript with one run's state (and error) changed, in its list and as the active run. */
function withRunState(
  transcript: Transcript,
  runId: string,
  state: RunState,
  error?: RunError | null
): Transcript {
  const change = (run: RunSnapshot): RunSnapshot =>
    error === undefined ? { ...run, state } : { ...run, state, error }
  const active = transcript.activeRun ?? null
  return {
    ...transcript,
    runs: transcript.runs.map((run) => (run.id === runId ? change(run) : run)),
    activeRun: active?.id === runId ? change(active) : active
  }
}

/** Applies one durable event past the transcript's seq; anything else returns the transcript itself. */
export function applyRunEvent(transcript: Transcript, event: Event): Transcript {
  if (event.seq === undefined || event.seq <= transcript.seq) return transcript
  const seq = event.seq
  const next: Transcript = { ...transcript, seq }
  const runId = runIdOf(event) ?? ''
  switch (event.type) {
    case 'run.queued': {
      const run: RunSnapshot = {
        id: runId,
        chatId: event.data.chatId,
        state: 'queued',
        profile: event.data.profile,
        model: event.data.model,
        seq,
        error: null
      }
      return { ...next, runs: [...next.runs, run], activeRun: run }
    }
    case 'input.received':
      return {
        ...next,
        items: [
          ...next.items,
          {
            kind: 'input',
            seq,
            runId,
            time: event.time,
            text: event.data.text,
            ...(event.data.quotes?.length ? { quotes: event.data.quotes } : {})
          }
        ],
        context: {
          ...withMessageCount(next.context, next.context.parts.messageCount + 1),
          used:
            next.context.used +
            estimateTokens(
              quotedInput(
                event.data.text,
                event.data.quotes?.map((q) => q.text)
              )
            )
        }
      }
    case 'run.started':
    case 'run.resumed':
      return withRunState(next, runId, 'running')
    case 'run.paused':
      return withRunState(next, runId, 'interrupted')
    case 'message.completed': {
      const { parts, stats, partial } = event.data
      const answer: TranscriptItem = { kind: 'answer', seq, runId, time: event.time, parts, stats, partial }
      return {
        ...next,
        items: [...next.items, answer],
        context: {
          ...withMessageCount(next.context, next.context.parts.messageCount + (counted(answer) ? 1 : 0)),
          used: stats.promptTokens + stats.answerTokens,
          size: stats.contextSize > 0 ? stats.contextSize : next.context.size
        }
      }
    }
    case 'compaction.completed': {
      const items: TranscriptItem[] = [
        ...next.items,
        { kind: 'summary', seq, runId, time: event.time, text: event.data.summary }
      ]
      const kept = items.filter((item) => item.seq >= event.data.firstKeptSeq && counted(item)).length
      return {
        ...next,
        items,
        context: { ...withMessageCount(next.context, kept), used: event.data.tokensAfter }
      }
    }
    case 'turn.retracted': {
      const retracted = event.data.runId
      const removed = next.items.filter((item) => item.runId === retracted && counted(item)).length
      return {
        ...next,
        items: next.items.filter((item) => item.runId !== retracted),
        context: withMessageCount(next.context, next.context.parts.messageCount - removed)
      }
    }
    case 'run.finished': {
      const finished = withRunState(next, runId, event.data.state, event.data.error ?? null)
      if (finished.activeRun?.id === runId) finished.activeRun = null
      if (event.data.state !== 'failed') return finished
      // Only the answer the failure cut off is failed; a complete earlier answer of the run stays (decision 23).
      const last = finished.items.findLastIndex((item) => item.runId === runId && item.kind === 'answer')
      if (last < 0 || !finished.items[last].partial) return finished
      const items = [...finished.items]
      const wasCounted = counted(items[last])
      items[last] = { ...items[last], failed: true }
      return {
        ...finished,
        items,
        context: withMessageCount(
          finished.context,
          finished.context.parts.messageCount - (wasCounted ? 1 : 0)
        )
      }
    }
    default:
      return next
  }
}

/** The run an event belongs to: the id in its `run:<id>` stream. */
export function runIdOf(event: Event): string | null {
  return event.stream.startsWith('run:') ? event.stream.slice('run:'.length) : null
}

/** The chat an event belongs to, from its payload or its `chat:<id>` stream. */
export function chatIdOf(event: Event): string | null {
  switch (event.type) {
    case 'run.queued':
    case 'run.started':
    case 'run.paused':
    case 'run.resumed':
    case 'run.finished':
    case 'input.received':
    case 'message.completed':
    case 'compaction.completed':
    case 'chat.deleted':
      return event.data.chatId
    case 'chat.created':
    case 'chat.titled':
    case 'chat.model':
    case 'turn.retracted':
      return event.stream.startsWith('chat:') ? event.stream.slice('chat:'.length) : null
    default:
      return null
  }
}

/** Tokens a text costs, roughly, the way core's budget.EstimateTokens counts them. */
export function estimateTokens(text: string): number {
  return Math.ceil(Array.from(text).length / 3.5)
}

/** An input as core's prompt writes it: each quote as a "> " blockquote, a blank line apart, a blank line, then the text. */
export function quotedInput(text: string, quotes: readonly string[] | undefined): string {
  const blocks = (quotes ?? [])
    .filter((quote) => quote !== '')
    .map((quote) =>
      quote
        .split('\n')
        .map((line) => {
          const bare = line.endsWith('\r') ? line.slice(0, -1) : line
          return bare === '' ? '>' : `> ${bare}`
        })
        .join('\n')
    )
  return blocks.length === 0 ? text : `${blocks.join('\n\n')}\n\n${text}`
}

/** What Ember shows for the open chat: text streaming, thinking (queued, loading, reasoning) or idle. */
export function answerState(
  activeRun: RunSnapshot | null,
  live: LiveAnswer | undefined,
  hasLiveEntry = true
): AnswerState {
  if (activeRun === null || !hasLiveEntry || activeRun.state === 'interrupted') return 'idle'
  if (activeRun.state === 'running' && live !== undefined && live.text !== '') return 'streaming'
  return 'thinking'
}

/** Why an answer has not started yet, while nothing of it shows: waiting for the lease, or the model loading. */
export function waitingLine({
  activeRun,
  live,
  sched,
  model,
  modelLoading
}: {
  activeRun: RunSnapshot | null
  live: LiveAnswer | undefined
  sched: SchedState | null
  model: string
  modelLoading: boolean
}): string | null {
  if (activeRun === null || (activeRun.state !== 'queued' && activeRun.state !== 'running')) return null
  if (live !== undefined && (live.text !== '' || live.reasoning !== '')) return null
  const waiting = sched?.waiting.find((entry) => entry.runId === activeRun.id)
  if (waiting) return `Waiting: ${waiting.why}`
  if (modelLoading) return `Loading ${model}…`
  return null
}

/** The keys of the input entries that are the first input of their run. */
export function firstInputs(entries: TranscriptEntry[]): Set<string> {
  const runs = new Set<string>()
  const keys = new Set<string>()
  for (const entry of entries) {
    if (entry.kind !== 'input' || runs.has(entry.runId)) continue
    runs.add(entry.runId)
    keys.add(entry.key)
  }
  return keys
}

/** How many input and answer entries come after the entry with this key; 0 when the key is not there. */
export function messagesAfter(entries: TranscriptEntry[], key: string): number {
  const at = entries.findIndex((entry) => entry.key === key)
  if (at < 0) return 0
  return entries.slice(at + 1).filter((entry) => entry.kind === 'input' || entry.kind === 'answer').length
}
