import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp } from '@app/createApp'
import { coreApi } from '@app/core/coreApi'
import type { ChatBody, Event, SchedState, Transcript } from '@app/core/generated'
import { runView, selectSched } from '@app/features/runs'
import type { AppStore } from '@app/store/store'
import { fakePlatform } from '../../../fakePlatform'
import { createFakeCoreHttp, type FakeCoreHttp } from '../../../fakeCoreHttp'

const transcriptPath = '/api/chats/c1/messages'

const snapshot = (seq: number): Transcript => ({
  seq,
  items: [],
  runs: [],
  activeRun: null,
  context: { used: 0, size: 0 }
})

const event = (type: string, seq: number, data: object, stream = 'run:r1'): Event =>
  ({ type, stream, seq, v: 1, time: 0, data }) as Event

const input = (seq: number, text: string): Event =>
  event('input.received', seq, { chatId: 'c1', requestId: `req-${seq}`, text })

const stats = {
  promptTokens: 10,
  answerTokens: 2,
  exact: true,
  tokensPerSecond: 0,
  firstTokenMs: 0,
  durationMs: 0,
  contextSize: 4096,
  reasoningMs: 0
}

interface Connected {
  store: AppStore
  http: FakeCoreHttp
  push(...events: Event[]): void
  /** Pushes a sched.state marker after what came before and waits for it: everything before it has been applied. */
  flush(): Promise<void>
  /** Holds GET /messages until release() is called. */
  gate: { release(): void }
}

let marker = 0

async function connect(options: { gated?: boolean } = {}): Promise<Connected> {
  const http = createFakeCoreHttp()
  let release = (): void => {}
  const opened = new Promise<void>((resolve) => {
    release = resolve
  })
  const fetch: typeof globalThis.fetch = async (request, init) => {
    const url = request instanceof Request ? request.url : String(request)
    if (options.gated && url.endsWith(transcriptPath)) await opened
    return http.fetch(request, init)
  }
  vi.stubGlobal('fetch', fetch)
  const fake = fakePlatform({
    coreState: {
      status: 'ready',
      port: 53121,
      version: '1.0.0',
      connection: { baseUrl: 'http://127.0.0.1:53121', token: 'a'.repeat(64) }
    }
  })
  const store = createApp({ platform: fake.platform })
  await vi.waitFor(() => expect(http.openStreams()).toBe(1))
  const push = (...events: Event[]): void => events.forEach((data) => http.push({ data }))
  const flush = async (): Promise<void> => {
    const sched: SchedState = { holder: `marker-${++marker}`, waiting: [] }
    push({ type: 'sched.state', stream: 'system', v: 1, time: 0, data: sched } as Event)
    await vi.waitFor(() => expect(selectSched(store.getState())).toEqual(sched))
  }
  return { store, http, push, flush, gate: { release } }
}

const cachedTranscript = (store: AppStore): Transcript | undefined =>
  coreApi.endpoints.getTranscript.select({ id: 'c1' })(store.getState()).data

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('registerRuns', () => {
  it('applies input.received and message.completed to a cached transcript', async () => {
    const { store, http, push, flush } = await connect()
    http.answer(transcriptPath, snapshot(3))
    await store.dispatch(coreApi.endpoints.getTranscript.initiate({ id: 'c1' }))

    push(
      input(4, 'hi'),
      event('message.completed', 5, {
        chatId: 'c1',
        model: 'tiny',
        partial: false,
        parts: [{ kind: 'text', text: 'Hello' }],
        stats
      })
    )
    await flush()

    expect(runView(cachedTranscript(store)!).entries).toMatchObject([
      { kind: 'input', text: 'hi' },
      { kind: 'answer', parts: [{ kind: 'text', text: 'Hello' }] }
    ])
  })

  it('ignores an event at or below the snapshot seq', async () => {
    const { store, http, push, flush } = await connect()
    http.answer(transcriptPath, snapshot(7))
    await store.dispatch(coreApi.endpoints.getTranscript.initiate({ id: 'c1' }))
    const before = cachedTranscript(store)

    push(input(6, 'old'), input(7, 'same'))
    await flush()

    expect(cachedTranscript(store)).toBe(before)
  })

  it('applies the events that arrived while the transcript loaded, except those it already holds', async () => {
    const { store, http, push, flush, gate } = await connect({ gated: true })
    http.answer(transcriptPath, snapshot(7))
    const loading = store.dispatch(coreApi.endpoints.getTranscript.initiate({ id: 'c1' }))

    push(input(6, 'old'), input(8, 'new'))
    await flush()
    gate.release()
    await loading

    await vi.waitFor(() => expect(cachedTranscript(store)?.seq).toBe(8))
    expect(cachedTranscript(store)?.items.map((item) => item.text)).toEqual(['new'])
  })

  it('drops an event for a chat with no cached transcript, without asking core', async () => {
    const { store, http, push, flush } = await connect()

    push(input(4, 'hi'))
    await flush()

    expect(cachedTranscript(store)).toBeUndefined()
    expect(http.requests.some((request) => request.url.includes('/api/chats'))).toBe(false)
  })

  it('patches a cached getChat with chat.model, run.queued and run.finished', async () => {
    const { store, http, push, flush } = await connect()
    const body: ChatBody = {
      seq: 2,
      chat: { id: 'c1', model: 'tiny', title: 'Hello', titleSource: 'auto', updatedAt: 0, activeRun: null }
    }
    http.answer('/api/chats/c1', body)
    await store.dispatch(coreApi.endpoints.getChat.initiate({ id: 'c1' }))
    const chat = (): ChatBody | undefined =>
      coreApi.endpoints.getChat.select({ id: 'c1' })(store.getState()).data

    push(
      event('chat.model', 3, { model: 'big' }, 'chat:c1'),
      event('run.queued', 4, { chatId: 'c1', model: 'big', origin: 'user', profile: 'chat', requestId: 'q' })
    )
    await flush()
    expect(chat()).toMatchObject({ seq: 4, chat: { model: 'big', activeRun: { id: 'r1', state: 'queued' } } })

    push(event('run.finished', 5, { chatId: 'c1', state: 'done' }))
    await flush()
    expect(chat()).toMatchObject({ seq: 5, chat: { activeRun: null } })
  })
})
