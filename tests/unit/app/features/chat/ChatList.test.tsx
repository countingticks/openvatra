import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { ChatItem, Event, Transcript } from '@app/core/generated'
import type { ModelInfo } from '@app/core/types'
import { routePath } from '@app/store/route'
import { Shell } from '@app/shell/Shell'
import { selectRoute } from '@app/store/uiSlice'
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

const tiny: ModelInfo = {
  id: 'tiny',
  state: 'stopped',
  busy: false,
  sizeBytes: 1024 ** 3,
  kind: 'chat',
  context: null,
  moe: false
}

const transcript: Transcript = { seq: 0, items: [], runs: [], activeRun: null, context: { used: 0, size: 0 } }

const event = (type: string, seq: number, data: object, stream = 'run:r1'): Event =>
  ({ type, stream, seq, v: 1, time: 0, data }) as Event

function show(chats: ChatItem[], saved: { lastRoute?: string } = {}): ReturnType<typeof renderWithStore> {
  // A chat model, so the Chat tab shows the chat rather than the welcome card.
  const rendered = renderWithStore(<Shell />, saved, { models: [tiny] })
  rendered.coreHttp.answer('/api/chats', { seq: 1, chats })
  for (const item of chats) {
    rendered.coreHttp.answer(`/api/chats/${item.id}`, { seq: 1, chat: item })
    rendered.coreHttp.answer(`/api/chats/${item.id}/messages`, transcript)
  }
  return rendered
}

const chatList = (): HTMLElement => screen.getByRole('list', { name: 'Chats' })
const rowNames = (): string[] =>
  within(chatList())
    .getAllByRole('button', { name: (_, element) => element.hasAttribute('title') })
    .map((row) => row.getAttribute('title') ?? '')
const row = (title: string): HTMLElement =>
  within(chatList()).getByRole('button', { name: new RegExp(`^${title}`) })

async function push(rendered: ReturnType<typeof renderWithStore>, ...events: Event[]): Promise<void> {
  await waitFor(() => expect(rendered.coreHttp.openStreams()).toBeGreaterThan(0))
  act(() => events.forEach((data) => rendered.coreHttp.push({ data })))
}

describe('ChatList', () => {
  it('lists the chats newest first under Chats', async () => {
    show([chat('c2', 'Rust lifetimes, again'), chat('c1', 'Trip to Cluj')])

    expect(screen.getByRole('heading', { level: 2, name: 'Chats' })).toBeInTheDocument()
    await screen.findByRole('list', { name: 'Chats' })
    expect(rowNames()).toEqual(['Rust lifetimes, again', 'Trip to Cluj'])
  })

  it('says so when there are no chats', async () => {
    show([])

    expect(await screen.findByText('No chats yet')).toBeInTheDocument()
  })

  it('opens a chat from its row and marks it current', async () => {
    const { store } = show([chat('c2', 'Rust lifetimes, again'), chat('c1', 'Trip to Cluj')])
    await screen.findByRole('list', { name: 'Chats' })

    fireEvent.click(row('Rust lifetimes, again'))

    expect(routePath(selectRoute(store.getState()))).toBe('chat/c2')
    expect(row('Rust lifetimes, again')).toHaveAttribute('aria-current', 'page')
    expect(row('Trip to Cluj')).not.toHaveAttribute('aria-current')
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Rust lifetimes, again' })
    ).toBeInTheDocument()
  })

  it('opens a new chat from the +', async () => {
    const { store } = show([chat('c1', 'Trip to Cluj')], { lastRoute: 'chat/c1' })
    await screen.findByRole('list', { name: 'Chats' })

    fireEvent.click(screen.getByRole('button', { name: 'New chat' }))

    expect(routePath(selectRoute(store.getState()))).toBe('chat')
    expect(screen.getByRole('heading', { level: 1, name: 'New chat' })).toBeInTheDocument()
  })

  it('says which chat is answering and which was cut off', async () => {
    show([
      chat('c2', 'Rust lifetimes, again', { activeRun: { id: 'r2', state: 'running' } }),
      chat('c1', 'Trip to Cluj', { activeRun: { id: 'r1', state: 'interrupted' } })
    ])
    await screen.findByRole('list', { name: 'Chats' })

    expect(row('Rust lifetimes, again')).toHaveAccessibleName('Rust lifetimes, again answering')
    expect(row('Trip to Cluj')).toHaveAccessibleName('Trip to Cluj cut off')
  })

  it('renames the row and the header on chat.titled, but never an auto title over a user one', async () => {
    const rendered = show([chat('c1', 'Hello')], { lastRoute: 'chat/c1' })
    await screen.findByRole('heading', { level: 1, name: 'Hello' })
    await screen.findByRole('list', { name: 'Chats' })

    await push(rendered, event('chat.titled', 2, { title: 'Trip to Cluj', source: 'user' }, 'chat:c1'))
    expect(await screen.findByRole('heading', { level: 1, name: 'Trip to Cluj' })).toBeInTheDocument()
    expect(rowNames()).toEqual(['Trip to Cluj'])

    await push(
      rendered,
      event('chat.titled', 3, { title: 'Cluj trip plans', source: 'auto' }, 'chat:c1'),
      event('run.queued', 4, { chatId: 'c1', model: 'tiny', origin: 'user', profile: 'chat', requestId: 'q' })
    )
    // The run.queued after it has landed, so the auto title has been seen.
    await waitFor(() => expect(row('Trip to Cluj')).toHaveAccessibleName('Trip to Cluj answering'))
    expect(screen.getByRole('heading', { level: 1, name: 'Trip to Cluj' })).toBeInTheDocument()
    expect(rowNames()).toEqual(['Trip to Cluj'])
  })
})
