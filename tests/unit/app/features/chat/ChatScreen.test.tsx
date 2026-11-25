import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { Provider } from 'react-redux'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  ChatBody,
  Event,
  MessageStats,
  RunSnapshot,
  Transcript,
  TranscriptItem
} from '@app/core/generated'
import type { ModelInfo } from '@app/core/types'
import { ChatScreen } from '@app/features/chat'
import { PlatformProvider } from '@app/platform/PlatformProvider'
import { navigated, selectCanGoBack, selectRoute } from '@app/store/uiSlice'
import { coreWrites } from '../../../fakeCoreHttp'
import { renderWithStore } from '../../../renderWithStore'

const model = (id: string, overrides: Partial<ModelInfo> = {}): ModelInfo => ({
  id,
  state: 'stopped',
  busy: false,
  sizeBytes: 1024 ** 3,
  kind: 'chat',
  context: null,
  moe: false,
  name: id,
  quant: null,
  tags: [],
  memory: null,
  ...overrides
})

const run = (overrides: Partial<RunSnapshot> = {}): RunSnapshot => ({
  id: 'r1',
  chatId: 'c1',
  state: 'done',
  profile: 'chat',
  model: 'tiny',
  seq: 1,
  error: null,
  ...overrides
})

const stats: MessageStats = {
  promptTokens: 10,
  answerTokens: 2,
  exact: true,
  tokensPerSecond: 0,
  firstTokenMs: 0,
  durationMs: 0,
  contextSize: 4096,
  reasoningMs: 0
}

const input = (seq: number, text: string): TranscriptItem => ({ kind: 'input', seq, runId: 'r1', text })
const answer = (seq: number, text: string): TranscriptItem => ({
  kind: 'answer',
  seq,
  runId: 'r1',
  parts: [{ kind: 'text', text }],
  stats,
  partial: false
})

const transcript = (overrides: Partial<Transcript> = {}): Transcript => ({
  seq: 0,
  items: [],
  runs: [],
  activeRun: null,
  context: { used: 0, size: 0, parts: { system: 0, messages: 0, messageCount: 0, search: 0, files: 0 } },
  ...overrides
})

const chatBody = (title = 'Quantization formats'): ChatBody => ({
  seq: 0,
  chat: { id: 'c1', title, titleSource: 'auto', model: 'tiny', updatedAt: 0 }
})

const event = (type: string, seq: number | undefined, data: object, stream = 'run:r1'): Event =>
  ({ type, stream, seq, v: 1, time: 0, data }) as Event

const message = (): HTMLElement => screen.getByRole('textbox', { name: 'Message' })
const conversation = (): HTMLElement => screen.getByRole('log', { name: 'Conversation' })
const runPosts = (http: ReturnType<typeof renderWithStore>['coreHttp']): unknown[] =>
  coreWrites(http)
    .filter((write) => write.method === 'POST' && write.path === '/api/runs')
    .map((write) => write.body)

interface Options {
  /** Opens this chat (its transcript and chat entry answer as given); omitted: a new chat. */
  open?: { transcript?: Transcript; chat?: ChatBody }
  models?: ModelInfo[]
}

function show(options: Options = {}): ReturnType<typeof renderWithStore> & {
  push(...events: Event[]): Promise<void>
} {
  const saved = options.open ? { lastRoute: 'chat/c1' } : {}
  const rendered = renderWithStore(<ChatScreen showWelcome={false} />, saved, {
    models: options.models ?? [model('tiny')]
  })
  const { coreHttp } = rendered
  coreHttp.answer('/api/chats/c1', options.open?.chat ?? chatBody())
  coreHttp.answer('/api/chats/c1/messages', options.open?.transcript ?? transcript())
  coreHttp.respond('POST', '/api/runs', () => ({
    status: 202,
    body: { runId: 'r1', chatId: 'c1', seq: 1 }
  }))
  coreHttp.respond('POST', '/api/runs/r1/stop', () => ({ status: 204 }))
  coreHttp.respond('POST', '/api/runs/r1/resume', () => ({ status: 204 }))
  const push = async (...events: Event[]): Promise<void> => {
    await waitFor(() => expect(coreHttp.openStreams()).toBeGreaterThan(0))
    act(() => events.forEach((data) => coreHttp.push({ data })))
  }
  return { ...rendered, push }
}

async function type(text: string): Promise<void> {
  fireEvent.change(message(), { target: { value: text } })
}

const enter = (init: object = {}): boolean => fireEvent.keyDown(message(), { key: 'Enter', ...init })

const nextFrame = (): void => {
  act(() => {
    vi.advanceTimersToNextFrame()
  })
}

describe('ChatScreen', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['requestAnimationFrame', 'cancelAnimationFrame'] })
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('starts a new chat with the first chat model, then shows it in place', async () => {
    const { coreHttp, store, push } = show()
    await screen.findByRole('button', { name: /^Model: tiny,/ })
    expect(message()).toHaveAttribute('placeholder', 'Ask anything…')

    await type('hi')
    enter()

    await waitFor(() =>
      expect(runPosts(coreHttp)).toEqual([{ requestId: expect.any(String), text: 'hi', model: 'tiny' }])
    )
    await waitFor(() => expect(selectRoute(store.getState())).toEqual({ tab: 'chat', chatId: 'c1' }))
    expect(selectCanGoBack(store.getState())).toBe(false)
    await waitFor(() => expect(message()).toHaveAttribute('placeholder', 'Reply…'))

    await push(
      event('run.queued', 1, { chatId: 'c1', profile: 'chat', model: 'tiny' }),
      event('input.received', 2, { chatId: 'c1', requestId: 'x', text: 'hi' })
    )
    expect(await within(conversation()).findByText('hi')).toBeInTheDocument()
  })

  it("shows nothing of the first chat while another chat's messages are on their way", async () => {
    const { coreHttp, store } = show({
      open: { transcript: transcript({ seq: 2, items: [input(1, 'first'), answer(2, 'earlier answer')] }) }
    })
    await within(conversation()).findByText('earlier answer')
    expect(await screen.findByRole('heading', { name: 'Quantization formats' })).toBeInTheDocument()

    let release = (): void => {}
    const opened = new Promise<void>((resolve) => {
      release = resolve
    })
    const original = coreHttp.fetch
    vi.stubGlobal('fetch', (async (input, init) => {
      const url = input instanceof Request ? input.url : String(input)
      if (new URL(url).pathname.startsWith('/api/chats/c2')) await opened
      return original(input, init)
    }) as typeof fetch)
    coreHttp.answer('/api/chats/c2', {
      seq: 0,
      chat: { id: 'c2', title: 'Second chat', titleSource: 'auto', model: 'tiny', updatedAt: 0 }
    })
    coreHttp.answer(
      '/api/chats/c2/messages',
      transcript({ seq: 1, items: [input(1, 'other question')], runs: [] })
    )

    act(() => {
      store.dispatch(navigated({ tab: 'chat', chatId: 'c2' }))
    })

    await waitFor(() => expect(screen.queryByText('earlier answer')).not.toBeInTheDocument())
    expect(screen.queryByRole('heading', { name: 'Quantization formats' })).not.toBeInTheDocument()

    release()
    expect(await within(conversation()).findByText('other question')).toBeInTheDocument()
  })

  it.each([
    ['installed', 'big', /^Model: big,/],
    ['not installed', 'gone', /^Model: tiny,/]
  ])('uses chat.lastModel when it is %s, else the first model', async (_case, lastModel, name) => {
    const rendered = renderWithStore(
      <ChatScreen showWelcome={false} />,
      {},
      {
        models: [model('tiny'), model('big')]
      }
    )
    rendered.coreHttp.setConfig('chat', { rev: 1, value: { lastModel } })

    expect(await screen.findByRole('button', { name })).toBeInTheDocument()
  })

  it.each([
    ['a new chat', {}, 'Ask anything…'],
    ['a saved chat', { open: {} }, 'Reply…']
  ])('words the message box for %s', async (_case, options, placeholder) => {
    show(options)
    expect(await screen.findByRole('textbox', { name: 'Message' })).toHaveAttribute(
      'placeholder',
      placeholder
    )
  })

  it('adds a line with Shift+Enter and never sends blank text', async () => {
    const { coreHttp } = show()
    await screen.findByRole('button', { name: /^Model: tiny,/ })

    await type('a')
    expect(enter({ shiftKey: true })).toBe(true)
    await type('a\nb')
    await type('   \n ')
    enter()

    await act(async () => {})
    expect(runPosts(coreHttp)).toEqual([])
    expect(screen.queryByRole('button', { name: 'Send (Enter)' })).not.toBeInTheDocument()
  })

  it('stops a running answer from the button and Esc, and queues what Enter sends', async () => {
    const running = run({ state: 'running' })
    const { coreHttp } = show({
      open: {
        transcript: transcript({ seq: 3, items: [input(2, 'hi')], runs: [running], activeRun: running })
      }
    })
    const stop = await screen.findByRole('button', { name: 'Stop (Esc)' })

    fireEvent.click(stop)
    fireEvent.keyDown(message(), { key: 'Escape' })
    await type('more')
    expect(screen.getByRole('button', { name: 'Stop (Esc)' })).toBeInTheDocument()
    enter()

    await waitFor(() =>
      expect(coreWrites(coreHttp).map((write) => write.path)).toEqual([
        '/api/runs/r1/stop',
        '/api/runs/r1/stop',
        '/api/runs'
      ])
    )
    expect(runPosts(coreHttp)).toEqual([{ requestId: expect.any(String), text: 'more', chatId: 'c1' }])
  })

  it("shows core's message when the send fails, keeps the text, and clears it on edit", async () => {
    const { coreHttp } = show()
    coreHttp.respond('POST', '/api/runs', () => ({
      status: 409,
      body: { error: 'no_chat_model', message: 'Install a chat model first.' }
    }))
    await screen.findByRole('button', { name: /^Model: tiny,/ })

    await type('hi')
    enter()

    expect(await screen.findByRole('alert')).toHaveTextContent('Install a chat model first.')
    expect(message()).toHaveValue('hi')
    await type('hi!')
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('restores the new-chat draft after a re-render and clears it after the send', async () => {
    const rendered = show()
    const { platform, store, unmount, coreHttp } = rendered
    await screen.findByRole('button', { name: /^Model: tiny,/ })
    await type('half a thought')
    unmount()

    render(
      <PlatformProvider platform={platform.platform}>
        <Provider store={store}>
          <ChatScreen showWelcome={false} />
        </Provider>
      </PlatformProvider>
    )
    expect(message()).toHaveValue('half a thought')
    enter()

    await waitFor(() => expect(runPosts(coreHttp)).toHaveLength(1))
    await waitFor(() => expect(platform.storage.values.has('chat.draft:new')).toBe(false))
    expect(message()).toHaveValue('')
  })

  it('lands on a new chat when the saved chat no longer exists', async () => {
    const { coreHttp, store } = renderWithStore(<ChatScreen showWelcome={false} />, { lastRoute: 'chat/c9' })
    coreHttp.answer(
      '/api/chats/c9/messages',
      { error: 'chat_not_found', message: 'No such chat.' },
      { status: 404 }
    )

    await waitFor(() => expect(selectRoute(store.getState())).toEqual({ tab: 'chat' }))
    expect(screen.getByRole('heading', { level: 1, name: 'New chat' })).toBeInTheDocument()
  })

  it("shows the chat's title, and New chat without one", async () => {
    const { store } = show({ open: {} })
    expect(await screen.findByRole('heading', { level: 1, name: 'Quantization formats' })).toBeInTheDocument()

    act(() => {
      store.dispatch(navigated({ tab: 'chat' }))
    })
    expect(screen.getByRole('heading', { level: 1, name: 'New chat' })).toBeInTheDocument()
  })

  it('announces "Answer finished" once an answer completes, not what was there on opening', async () => {
    const running = run({ state: 'running' })
    const { push } = show({
      open: {
        transcript: transcript({
          seq: 4,
          items: [input(1, 'first'), answer(2, 'earlier answer'), input(4, 'second')],
          runs: [running],
          activeRun: running
        })
      }
    })
    await within(conversation()).findByText('earlier answer')
    expect(screen.getByRole('status')).toHaveTextContent('')

    await push(
      event('message.completed', 5, {
        chatId: 'c1',
        parts: [{ kind: 'text', text: 'new answer' }],
        stats,
        partial: false
      })
    )

    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Answer finished'))
  })

  it('offers Scroll to latest while scrolled away', async () => {
    const running = run({ state: 'running' })
    const { push } = show({
      open: {
        transcript: transcript({
          seq: 4,
          items: [input(1, 'first'), answer(2, 'earlier answer'), input(4, 'second')],
          runs: [running],
          activeRun: running
        })
      }
    })
    await within(conversation()).findByText('earlier answer')
    Object.defineProperty(conversation(), 'scrollHeight', { value: 2000, configurable: true })
    Object.defineProperty(conversation(), 'clientHeight', { value: 400, configurable: true })
    conversation().scrollTop = 0
    fireEvent.scroll(conversation())

    expect(await screen.findByRole('button', { name: 'Scroll to latest' })).toBeInTheDocument()

    await push(
      event('message.completed', 5, {
        chatId: 'c1',
        parts: [{ kind: 'text', text: 'new answer' }],
        stats,
        partial: false
      }),
      event('run.finished', 6, { chatId: 'c1', state: 'done' })
    )

    expect(await screen.findByRole('button', { name: 'Scroll to latest' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Scroll to latest, new text below' })).not.toBeInTheDocument()
  })

  it("announces a failed run's message", async () => {
    const running = run({ state: 'running' })
    const { push } = show({
      open: {
        transcript: transcript({ seq: 2, items: [input(2, 'hi')], runs: [running], activeRun: running })
      }
    })
    await within(conversation()).findByText('hi')

    await push(
      event('run.finished', 3, {
        chatId: 'c1',
        state: 'failed',
        error: { code: 'backend_failed', message: 'The model stopped answering.' }
      })
    )

    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('The model stopped answering.'))
  })

  it('shows Ember thinking once the run starts and streaming at the first text', async () => {
    const { push } = show({ open: { transcript: transcript({ seq: 2, items: [], runs: [] }) } })
    expect(await screen.findByRole('img', { name: 'Ember, idle' })).toBeInTheDocument()

    await push(
      event('run.queued', 3, { chatId: 'c1', profile: 'chat', model: 'tiny' }),
      event('input.received', 4, { chatId: 'c1', requestId: 'x', text: 'hi' }),
      event('run.started', 5, { chatId: 'c1' })
    )
    expect(await screen.findByRole('img', { name: 'Ember, thinking' })).toBeInTheDocument()

    await push(event('message.delta', undefined, { text: 'Hel', n: 1 }))
    await waitFor(() => {
      nextFrame()
      expect(screen.getByRole('img', { name: 'Ember, streaming' })).toBeInTheDocument()
    })
  })

  it('picks the model of a new chat, and the first send uses it', async () => {
    const { coreHttp } = show({ models: [model('tiny'), model('m2')] })
    await screen.findByRole('button', { name: /^Model: tiny,/ })

    fireEvent.click(screen.getByRole('button', { name: /^Model:/ }))
    const popover = await screen.findByRole('dialog', { name: 'Models service' })
    fireEvent.click(within(popover).getByRole('option', { name: 'm2' }))

    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Models service' })).not.toBeInTheDocument()
    )
    expect(screen.getByRole('button', { name: 'Model: m2, not loaded. Change model' })).toBeInTheDocument()
    await type('hi')
    enter()
    await waitFor(() =>
      expect(runPosts(coreHttp)).toEqual([{ requestId: expect.any(String), text: 'hi', model: 'm2' }])
    )
  })

  it("sets a saved chat's model through core, and shows why it could not", async () => {
    const { coreHttp } = show({ open: {}, models: [model('tiny'), model('m2')] })
    coreHttp.respond('PATCH', '/api/chats/c1', () => ({
      status: 404,
      body: { error: 'model_not_found', message: 'm2 is no longer installed.' }
    }))
    await screen.findByRole('button', { name: 'Model: tiny, not loaded. Change model' })

    fireEvent.click(screen.getByRole('button', { name: /^Model:/ }))
    const popover = await screen.findByRole('dialog', { name: 'Models service' })
    fireEvent.click(within(popover).getByRole('option', { name: 'm2' }))

    expect(await within(popover).findByRole('alert')).toHaveTextContent('m2 is no longer installed.')
    expect(coreWrites(coreHttp)).toContainEqual({
      method: 'PATCH',
      path: '/api/chats/c1',
      body: { model: 'm2' }
    })
    expect(screen.getByRole('dialog', { name: 'Models service' })).toBeInTheDocument()
  })

  it('shows how full the context is, and nothing for a new chat', async () => {
    const { store } = show({
      open: {
        transcript: transcript({
          context: {
            used: 3174,
            size: 32768,
            parts: { system: 0, messages: 0, messageCount: 0, search: 0, files: 0 }
          }
        })
      }
    })

    expect(await screen.findByText('3.1k / 32k')).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'Context: 3,174 of 32,768 tokens used. Show details' })
    ).toBeInTheDocument()

    act(() => {
      store.dispatch(navigated({ tab: 'chat' }))
    })
    expect(screen.queryByRole('button', { name: /^Context:/ })).not.toBeInTheDocument()
  })

  it('closes the model popover when the context popover opens, and the other way round', async () => {
    show({
      open: {
        transcript: transcript({
          context: {
            used: 3174,
            size: 32768,
            parts: { system: 900, messages: 0, messageCount: 2, search: 0, files: 0 }
          }
        })
      }
    })
    // Each popover is a press outside the other; a real press is pointer events, then the click.
    const press = (target: HTMLElement): void => {
      fireEvent.pointerDown(target)
      fireEvent.mouseDown(target)
      fireEvent.pointerUp(target)
      fireEvent.mouseUp(target)
      fireEvent.click(target)
    }
    const models = (): HTMLElement | null => screen.queryByRole('dialog', { name: 'Models service' })
    const context = (): HTMLElement | null => screen.queryByRole('dialog', { name: 'Context usage' })

    await screen.findByRole('button', { name: /^Context:/ })
    fireEvent.click(screen.getByRole('button', { name: /^Model:/ }))
    await screen.findByRole('dialog', { name: 'Models service' })
    press(screen.getByRole('button', { name: /^Context:/, hidden: true }))
    await screen.findByRole('dialog', { name: 'Context usage' })
    await waitFor(() => expect(models()).not.toBeInTheDocument())

    press(screen.getByRole('button', { name: /^Model:/, hidden: true }))
    await screen.findByRole('dialog', { name: 'Models service' })
    await waitFor(() => expect(context()).not.toBeInTheDocument())
  })

  it("follows the answer's token counts into the meter", async () => {
    const running = run({ state: 'running' })
    const { push } = show({
      open: {
        transcript: transcript({
          seq: 2,
          items: [input(2, 'hi')],
          runs: [running],
          activeRun: running,
          context: {
            used: 20,
            size: 32768,
            parts: { system: 0, messages: 0, messageCount: 0, search: 0, files: 0 }
          }
        })
      }
    })
    await screen.findByText('20 / 32k')

    await push(
      event('message.completed', 3, {
        chatId: 'c1',
        parts: [{ kind: 'text', text: 'Hello' }],
        stats: { ...stats, promptTokens: 900, answerTokens: 100, contextSize: 32768 },
        partial: false
      })
    )

    expect(await screen.findByText('1000 / 32k')).toBeInTheDocument()
  })

  it('continues an interrupted run', async () => {
    const interrupted = run({ state: 'interrupted' })
    const { coreHttp } = show({
      open: {
        transcript: transcript({
          seq: 2,
          items: [input(2, 'hi')],
          runs: [interrupted],
          activeRun: interrupted
        })
      }
    })

    fireEvent.click(await screen.findByRole('button', { name: 'Continue' }))

    await waitFor(() =>
      expect(coreWrites(coreHttp)).toContainEqual({
        method: 'POST',
        path: '/api/runs/r1/resume',
        body: undefined
      })
    )
  })

  describe('redoing the last turn', () => {
    const done = (): Transcript =>
      transcript({
        seq: 3,
        items: [input(2, 'hi'), answer(3, 'old answer')],
        runs: [run()]
      })

    it('regenerates from the button, and edits with the new text', async () => {
      const { coreHttp } = show({ open: { transcript: done() } })

      fireEvent.click(await screen.findByRole('button', { name: 'Regenerate answer' }))
      await waitFor(() =>
        expect(runPosts(coreHttp)).toEqual([{ requestId: expect.any(String), chatId: 'c1', replace: 'last' }])
      )

      fireEvent.click(screen.getByRole('button', { name: 'Edit message' }))
      fireEvent.change(screen.getByRole('textbox', { name: 'Edit message' }), { target: { value: 'hello' } })
      fireEvent.click(screen.getByRole('button', { name: 'Send' }))
      await waitFor(() =>
        expect(runPosts(coreHttp)).toContainEqual({
          requestId: expect.any(String),
          chatId: 'c1',
          text: 'hello',
          replace: 'last'
        })
      )
    })

    it('swaps the old turn for the new one as the events arrive', async () => {
      const { push } = show({ open: { transcript: done() } })
      expect(await within(conversation()).findByText('old answer')).toBeInTheDocument()

      await push(
        event('turn.retracted', 4, { runId: 'r1' }, 'chat:c1'),
        event('run.queued', 5, { chatId: 'c1', profile: 'chat', model: 'tiny' }, 'run:r2'),
        event('input.received', 6, { chatId: 'c1', requestId: 'x', text: 'hi' }, 'run:r2'),
        event(
          'message.completed',
          7,
          { chatId: 'c1', parts: [{ kind: 'text', text: 'new answer' }], stats, partial: false },
          'run:r2'
        ),
        event('run.finished', 8, { chatId: 'c1', state: 'done' }, 'run:r2')
      )

      expect(await within(conversation()).findByText('new answer')).toBeInTheDocument()
      expect(within(conversation()).queryByText('old answer')).toBeNull()
    })
  })
})
