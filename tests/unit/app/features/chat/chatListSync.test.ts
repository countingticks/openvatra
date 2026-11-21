import { createElement } from 'react'
import { act, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { ChatItem, ChatList as ChatListBody, Event, SchedState } from '@app/core/generated'
import { ChatList } from '@app/features/chat'
import { selectSched } from '@app/features/runs'
import { renderWithStore } from '../../../renderWithStore'

const chat = (id: string, title: string, overrides: Partial<ChatItem> = {}): ChatItem => ({
  id,
  title,
  titleSource: 'auto',
  model: 'tiny',
  updatedAt: 0,
  activeRun: null,
  ...overrides
})

const event = (type: string, seq: number, data: object, stream = 'run:r1', time = 0): Event =>
  ({ type, stream, seq, v: 1, time, data }) as Event

const queued = (seq: number, chatId: string, runId = 'r1'): Event =>
  event(
    'run.queued',
    seq,
    { chatId, model: 'tiny', origin: 'user', profile: 'chat', requestId: `q${seq}` },
    `run:${runId}`
  )

let marker = 0

interface Shown {
  rendered: ReturnType<typeof renderWithStore>
  push(...events: Event[]): Promise<void>
  /** Pushes a sched.state marker and waits for it: everything pushed before it has been seen. */
  flush(): Promise<void>
  /** How many times the window asked core for the list. */
  listRequests(): number
}

function show(body: ChatListBody, options: { gated?: boolean } = {}): Shown & { release(): void } {
  // The fake core answers through fetch, so holding the list means holding that fetch.
  let release = (): void => {}
  const opened = new Promise<void>((resolve) => {
    release = resolve
  })
  const rendered = renderWithStore(createElement(ChatList))
  const http = rendered.coreHttp
  const original = http.fetch
  if (options.gated) {
    const gatedFetch: typeof fetch = async (input, init) => {
      const url = input instanceof Request ? input.url : String(input)
      if (new URL(url).pathname === '/api/chats') await opened
      return original(input, init)
    }
    vi.stubGlobal('fetch', gatedFetch)
  }
  http.answer('/api/chats', body)
  const push = async (...events: Event[]): Promise<void> => {
    await waitFor(() => expect(http.openStreams()).toBeGreaterThan(0))
    act(() => events.forEach((data) => http.push({ data })))
  }
  const flush = async (): Promise<void> => {
    const sched: SchedState = { holder: `marker-${++marker}`, waiting: [] }
    await push({ type: 'sched.state', stream: 'system', v: 1, time: 0, data: sched } as Event)
    await waitFor(() => expect(selectSched(rendered.store.getState())).toEqual(sched))
  }
  const listRequests = (): number =>
    http.requests.filter((request) => new URL(request.url).pathname === '/api/chats').length
  return { rendered, push, flush, listRequests, release }
}

const titles = (): string[] =>
  within(screen.getByRole('list', { name: 'Chats' }))
    .getAllByRole('button', { name: (_, element) => element.hasAttribute('title') })
    .map((row) => row.getAttribute('title') ?? '')

const row = (title: string): HTMLElement =>
  within(screen.getByRole('list', { name: 'Chats' })).getByRole('button', { name: new RegExp(`^${title}`) })

describe('registerChatList', () => {
  it('moves a chat to the top on input.received and clears its dot on run.finished', async () => {
    const { push } = show({
      seq: 1,
      chats: [chat('c2', 'Rust lifetimes, again'), chat('c1', 'Trip to Cluj')]
    })
    await screen.findByRole('list', { name: 'Chats' })

    await push(
      event('input.received', 2, { chatId: 'c1', requestId: 'q', text: 'Hi' }, 'run:r1', 10),
      queued(3, 'c1'),
      event('run.started', 4, { chatId: 'c1' })
    )
    await waitFor(() => expect(titles()).toEqual(['Trip to Cluj', 'Rust lifetimes, again']))
    await waitFor(() => expect(row('Trip to Cluj')).toHaveAccessibleName('Trip to Cluj answering'))

    await push(event('run.finished', 5, { chatId: 'c1', state: 'done' }, 'run:r1', 20))
    await waitFor(() => expect(row('Trip to Cluj')).toHaveAccessibleName('Trip to Cluj'))
  })

  it('refetches the list once for a run.queued of a chat it does not have', async () => {
    const { rendered, push, listRequests } = show({ seq: 1, chats: [chat('c1', 'Trip to Cluj')] })
    await screen.findByRole('list', { name: 'Chats' })
    expect(listRequests()).toBe(1)
    rendered.coreHttp.answer('/api/chats', {
      seq: 3,
      chats: [chat('c9', 'Hello', { activeRun: { id: 'r9', state: 'queued' } }), chat('c1', 'Trip to Cluj')]
    })

    await push(
      queued(2, 'c9', 'r9'),
      event('input.received', 3, { chatId: 'c9', requestId: 'q', text: 'Hello' }, 'run:r9')
    )

    await waitFor(() => expect(titles()).toEqual(['Hello', 'Trip to Cluj']))
    expect(listRequests()).toBe(2)
  })

  it('removes a chat on chat.deleted', async () => {
    const { push } = show({
      seq: 1,
      chats: [chat('c2', 'Rust lifetimes, again'), chat('c1', 'Trip to Cluj')]
    })
    await screen.findByRole('list', { name: 'Chats' })

    await push(event('chat.deleted', 2, { chatId: 'c2' }, 'chat:c2'))

    await waitFor(() => expect(titles()).toEqual(['Trip to Cluj']))
  })

  it('applies an event that arrived while the list loaded, except one at or below its seq', async () => {
    const { push, flush, release } = show({ seq: 3, chats: [chat('c1', 'Trip to Cluj')] }, { gated: true })

    await push(
      event('chat.titled', 3, { title: 'Already in the list', source: 'auto' }, 'chat:c1'),
      event('chat.titled', 4, { title: 'Cluj in autumn', source: 'auto' }, 'chat:c1')
    )
    await flush()
    expect(screen.queryByRole('list', { name: 'Chats' })).not.toBeInTheDocument()
    release()

    await waitFor(() => expect(titles()).toEqual(['Cluj in autumn']))
    await push(event('chat.titled', 2, { title: 'Too old', source: 'auto' }, 'chat:c1'))
    await flush()
    expect(titles()).toEqual(['Cluj in autumn'])
  })
})
