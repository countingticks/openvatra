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

const input = (seq: number, text: string): TranscriptItem => ({
  kind: 'input',
  seq,
  runId: 'r1',
  time: 0,
  text
})
const answer = (seq: number, text: string): TranscriptItem => ({
  kind: 'answer',
  seq,
  runId: 'r1',
  time: 0,
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
  storage?: Record<string, string>
}

function show(options: Options = {}): ReturnType<typeof renderWithStore> & {
  push(...events: Event[]): Promise<void>
} {
  const saved = options.open ? { lastRoute: 'chat/c1' } : {}
  const rendered = renderWithStore(<ChatScreen showWelcome={false} />, saved, {
    models: options.models ?? [model('tiny')],
    storage: options.storage
  })
  const { coreHttp } = rendered
  coreHttp.answer('/api/chats/c1', options.open?.chat ?? chatBody())
  coreHttp.answer('/api/chats/c1/messages', options.open?.transcript ?? transcript())
  coreHttp.respond('POST', '/api/runs', () => ({
    status: 202,
    body: { runId: 'r1', time: 0, chatId: 'c1', seq: 1 }
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

  it('a send with a quote posts it', async () => {
    const { coreHttp } = show({ storage: { 'chat.quotes:new': JSON.stringify(['q']) } })
    await screen.findByRole('button', { name: /^Model: tiny,/ })

    await type('Explain')
    enter()

    await waitFor(() =>
      expect(runPosts(coreHttp)).toEqual([
        { requestId: expect.any(String), text: 'Explain', model: 'tiny', quotes: [{ text: 'q' }] }
      ])
    )
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
    ['big', 'big', 'big'],
    [null, 'big', 'tiny'],
    ['big', 'tiny', 'tiny']
  ])(
    'shows the fallback for a saved chat whose model is gone (lastModel %s, chat model %s)',
    async (lastModel, chatModel, expected) => {
      const { coreHttp } = show({
        open: {
          chat: { ...chatBody(), chat: { ...chatBody().chat, model: chatModel === 'tiny' ? 'tiny' : 'gone' } }
        },
        models: [model('tiny'), model('big')]
      })
      coreHttp.setConfig('chat', { rev: 1, value: { lastModel } })

      expect(
        await screen.findByRole('button', { name: new RegExp(`^Model: ${expected},`) })
      ).toBeInTheDocument()
    }
  )

  it('keeps a saved chat model when no chat model is installed', async () => {
    show({
      open: { chat: { ...chatBody(), chat: { ...chatBody().chat, model: 'gone' } } },
      models: []
    })

    expect(await screen.findByRole('button', { name: /^Model: gone,/ })).toBeInTheDocument()
  })

  it('grows the context while an answer streams, then shows the exact number', async () => {
    const running = run({ state: 'running' })
    const { push } = show({
      open: {
        transcript: transcript({
          seq: 3,
          items: [input(2, 'hi')],
          runs: [running],
          activeRun: running,
          context: {
            used: 3174,
            size: 32768,
            parts: { system: 0, messages: 0, messageCount: 0, search: 0, files: 0 }
          }
        })
      }
    })
    await screen.findByText('3.1k / 32k')

    await push(
      event('run.started', 4, { chatId: 'c1' }),
      event('message.delta', undefined, { text: 'x'.repeat(35), n: 10 })
    )
    await waitFor(() => {
      nextFrame()
      expect(
        screen.getByRole('button', { name: 'Context: 3,184 of 32,768 tokens used. Show details' })
      ).toBeInTheDocument()
    })

    await push(
      event('message.completed', 5, {
        chatId: 'c1',
        parts: [{ kind: 'text', text: 'x'.repeat(35) }],
        stats: { ...stats, promptTokens: 3200, answerTokens: 50, contextSize: 32768 },
        partial: false
      })
    )
    await waitFor(() => {
      nextFrame()
      expect(
        screen.getByRole('button', { name: 'Context: 3,250 of 32,768 tokens used. Show details' })
      ).toBeInTheDocument()
    })
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
          replaceFrom: 'r1'
        })
      )
    })

    it('Edit of a quoted message posts replaceFrom with its quote', async () => {
      const { coreHttp } = show({
        open: {
          transcript: transcript({
            seq: 3,
            items: [{ ...input(2, 'hi'), quotes: [{ text: 'q' }] }, answer(3, 'old answer')],
            runs: [run()]
          })
        }
      })

      fireEvent.click(await screen.findByRole('button', { name: 'Edit message' }))
      fireEvent.click(screen.getByRole('button', { name: 'Send' }))
      await waitFor(() =>
        expect(runPosts(coreHttp)).toContainEqual({
          requestId: expect.any(String),
          chatId: 'c1',
          text: 'hi',
          replaceFrom: 'r1',
          quotes: [{ text: 'q' }]
        })
      )
    })

    it('Rewind posts the run at once and puts its text in the message box, replacing the draft', async () => {
      const { coreHttp } = show({ open: { transcript: done() } })
      coreHttp.respond('POST', '/api/chats/c1/rewind', () => ({ status: 200, body: { seq: 4, text: 'hi' } }))
      fireEvent.change(message(), { target: { value: 'half typed' } })

      fireEvent.click(await screen.findByRole('button', { name: 'Rewind message' }))

      await waitFor(() =>
        expect(coreWrites(coreHttp)).toContainEqual({
          method: 'POST',
          path: '/api/chats/c1/rewind',
          body: { runId: 'r1' }
        })
      )
      await waitFor(() => expect(message()).toHaveValue('hi'))
      expect(message()).toHaveFocus()
    })

    it('Rewind of a quoted message puts its text and quote back in the box', async () => {
      const { coreHttp } = show({ open: { transcript: done() } })
      coreHttp.respond('POST', '/api/chats/c1/rewind', () => ({
        status: 200,
        body: { seq: 4, text: 'hi', quotes: [{ text: 'q' }] }
      }))

      fireEvent.click(await screen.findByRole('button', { name: 'Rewind message' }))

      await waitFor(() => expect(message()).toHaveValue('hi'))
      expect(screen.getByRole('group', { name: 'Quote' })).toHaveTextContent('q')
    })

    it('a refused rewind is logged and leaves the box as it was', async () => {
      const { coreHttp } = show({ open: { transcript: done() } })
      coreHttp.respond('POST', '/api/chats/c1/rewind', () => ({
        status: 409,
        body: { error: 'chat_busy', message: 'the chat is answering; stop it first' }
      }))
      const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined)
      fireEvent.change(message(), { target: { value: 'half typed' } })

      fireEvent.click(await screen.findByRole('button', { name: 'Rewind message' }))

      await waitFor(() => expect(logged).toHaveBeenCalledWith('Could not rewind the chat', expect.anything()))
      expect(message()).toHaveValue('half typed')
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

  describe('quoting a selection', () => {
    const rect = { top: 100, bottom: 120, left: 10, right: 50, width: 40, height: 20, x: 10, y: 100 }

    beforeEach(() => {
      // jsdom has no layout: a fixed rectangle for every range.
      Object.defineProperty(Range.prototype, 'getClientRects', {
        value: () => [rect],
        configurable: true
      })
      Object.defineProperty(Range.prototype, 'getBoundingClientRect', {
        value: () => rect,
        configurable: true
      })
    })

    afterEach(() => {
      document.getSelection()?.removeAllRanges()
    })

    const select = (node: Node, start: number, end: number): void => {
      const range = document.createRange()
      range.setStart(node, start)
      range.setEnd(node, end)
      const selection = document.getSelection()
      selection?.removeAllRanges()
      selection?.addRange(range)
      fireEvent(document, new Event('selectionchange'))
    }
    const textOf = (element: HTMLElement): Text => element.firstChild as Text
    const answered = (text: string, extra: Partial<TranscriptItem> = {}): Transcript =>
      transcript({
        seq: 2,
        items: [input(1, 'first'), { ...answer(2, text), ...extra }],
        runs: [run()]
      })

    it("selecting an answer's words shows Reply, and clicking it puts the chip in the box", async () => {
      show({ open: { transcript: answered('Some answer words') } })
      const words = await screen.findByText('Some answer words')

      select(textOf(words), 5, 11)
      fireEvent.click(await screen.findByRole('button', { name: 'Reply' }))

      expect(screen.getByRole('group', { name: 'Quote' })).toHaveTextContent('answer')
      expect(screen.queryByRole('button', { name: 'Reply' })).toBeNull()
      expect(message()).toHaveFocus()
    })

    it('selecting thinking or the live answer shows no Quote', async () => {
      const { push } = show({
        open: {
          transcript: answered('Done', {
            parts: [
              { kind: 'reasoning', text: 'pondering deeply' },
              { kind: 'text', text: 'Done' }
            ]
          })
        }
      })
      fireEvent.click(await screen.findByRole('button', { name: /Thought/ }))
      select(textOf(screen.getByText('pondering deeply')), 0, 9)
      expect(screen.queryByRole('button', { name: 'Reply' })).toBeNull()

      await push(
        event('run.queued', 3, { chatId: 'c1', profile: 'chat', model: 'tiny' }),
        event('input.received', 4, { chatId: 'c1', requestId: 'x', text: 'again' }),
        event('run.started', 5, { chatId: 'c1' }),
        event('message.delta', undefined, { text: 'Streaming words', n: 1 })
      )
      const live = await screen.findByText('Streaming words')
      select(textOf(live), 0, 9)
      expect(screen.queryByRole('button', { name: 'Reply' })).toBeNull()
    })

    it('Escape and a scroll of the conversation hide Reply', async () => {
      show({ open: { transcript: answered('Some answer words') } })
      const words = await screen.findByText('Some answer words')

      select(textOf(words), 0, 4)
      expect(await screen.findByRole('button', { name: 'Reply' })).toBeInTheDocument()
      fireEvent.keyDown(document, { key: 'Escape' })
      expect(screen.queryByRole('button', { name: 'Reply' })).toBeNull()

      select(textOf(words), 0, 4)
      expect(await screen.findByRole('button', { name: 'Reply' })).toBeInTheDocument()
      fireEvent.scroll(conversation())
      expect(screen.queryByRole('button', { name: 'Reply' })).toBeNull()
    })

    it('a selection over 4,000 characters shows Reply as aria-disabled with its title', async () => {
      show({ open: { transcript: answered('x'.repeat(4001)) } })
      const words = await screen.findByText('x'.repeat(4001))

      select(textOf(words), 0, 4001)
      const quote = await screen.findByRole('button', { name: 'Reply' })
      expect(quote).toHaveAttribute('aria-disabled', 'true')
      expect(quote).toHaveAttribute('title', 'Select at most 4,000 characters to quote')
      fireEvent.click(quote)

      expect(screen.queryByRole('group', { name: 'Quote' })).toBeNull()
    })

    it("Reply is centred over the selection's width", async () => {
      show({ open: { transcript: answered('Some answer words') } })
      const words = await screen.findByText('Some answer words')
      // jsdom's zero-sized scroller would clamp the button to its edge: give it room.
      const area = { ...rect, top: 0, bottom: 800, left: 0, right: 1000, width: 1000, height: 800 }
      conversation().getBoundingClientRect = () => area as DOMRect
      const wide = { ...rect, left: 200, right: 300, width: 100 }
      Object.defineProperty(Range.prototype, 'getBoundingClientRect', {
        value: () => wide,
        configurable: true
      })

      select(textOf(words), 0, 4)
      const reply = await screen.findByRole('button', { name: 'Reply' })
      const layerLeft = (reply.parentElement as HTMLElement).getBoundingClientRect().left

      expect(reply.style.left).toBe(`${(wide.left + wide.right) / 2 - layerLeft}px`)
    })

    it('with five quotes in the box Reply is aria-disabled with its title', async () => {
      show({
        open: { transcript: answered('Some answer words') },
        storage: { 'chat.quotes:c1': JSON.stringify(['1', '2', '3', '4', '5']) }
      })
      const words = await screen.findByText('Some answer words')

      select(textOf(words), 0, 4)
      const reply = await screen.findByRole('button', { name: 'Reply' })
      expect(reply).toHaveAttribute('aria-disabled', 'true')
      expect(reply).toHaveAttribute('title', 'At most 5 quotes per message')
      fireEvent.click(reply)

      expect(screen.getAllByRole('group', { name: 'Quote' })).toHaveLength(5)
    })
  })
})
