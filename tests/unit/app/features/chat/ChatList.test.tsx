import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ChatItem, Event, Transcript } from '@app/core/generated'
import type { ModelInfo } from '@app/core/types'
import { routePath } from '@app/store/route'
import { Shell } from '@app/shell/Shell'
import { selectRoute } from '@app/store/uiSlice'
import { coreWrites } from '../../../fakeCoreHttp'
import type { OptionalMember } from '../../../fakePlatform'
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
  moe: false,
  name: 'tiny',
  quant: null,
  tags: [],
  memory: null
}

const transcript: Transcript = {
  seq: 0,
  items: [],
  runs: [],
  activeRun: null,
  context: { used: 0, size: 0, parts: { system: 0, messages: 0, messageCount: 0, search: 0, files: 0 } }
}

const event = (type: string, seq: number, data: object, stream = 'run:r1'): Event =>
  ({ type, stream, seq, v: 1, time: 0, data }) as Event

function show(
  chats: ChatItem[],
  saved: { lastRoute?: string } = {},
  omit: readonly OptionalMember[] = [],
  storage: Record<string, string> = {}
): ReturnType<typeof renderWithStore> {
  // A chat model, so the Chat tab shows the chat rather than the welcome card.
  const rendered = renderWithStore(<Shell />, saved, { models: [tiny], omit, storage })
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

describe('date groups', () => {
  const day = 24 * 3_600_000
  const now = new Date(2026, 10, 18, 15, 30).getTime()
  const dated = [
    chat('c3', 'Fresh chat', { updatedAt: now - 3_600_000 }),
    chat('c2', 'Mid week', { updatedAt: now - 3 * day }),
    chat('c1', 'Ancient', { updatedAt: now - 30 * day })
  ]
  const headers = (): string[] =>
    within(chatList())
      .getAllByRole('button', { expanded: true })
      .concat(within(chatList()).queryAllByRole('button', { expanded: false }))
      .filter((button) => !button.getAttribute('aria-label')?.startsWith('Actions for'))
      .map((button) => button.textContent ?? '')
  const header = (label: string): HTMLElement => within(chatList()).getByRole('button', { name: label })

  afterEach(() => {
    vi.useRealTimers()
  })

  function showDated(
    chats: ChatItem[] = dated,
    saved: { lastRoute?: string } = {},
    storage: Record<string, string> = {}
  ): ReturnType<typeof renderWithStore> {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(now)
    return show(chats, saved, [], storage)
  }

  it('lists Today, Previous 7 days and Older in that order, each expanded', async () => {
    showDated()
    await screen.findByRole('list', { name: 'Chats' })

    expect(headers()).toEqual(['Today', 'Previous 7 days', 'Older'])
    for (const label of ['Today', 'Previous 7 days', 'Older']) {
      expect(header(label)).toHaveAttribute('aria-expanded', 'true')
    }
    expect(within(screen.getByRole('list', { name: 'Today' })).getByTitle('Fresh chat')).toBeInTheDocument()
  })

  it('has no header for a group without chats', async () => {
    showDated([dated[0]])
    await screen.findByRole('list', { name: 'Chats' })

    expect(headers()).toEqual(['Today'])
  })

  it('keeps every row under the Chats list for chats of any age', async () => {
    showDated([chat('c1', 'Trip to Cluj')])
    await screen.findByRole('list', { name: 'Chats' })

    expect(within(screen.getByRole('list', { name: 'Older' })).getAllByRole('button')).not.toHaveLength(0)
    expect(rowNames()).toEqual(['Trip to Cluj'])
  })

  it('folds a group, hiding its rows, and remembers it', async () => {
    const rendered = showDated()
    await screen.findByRole('list', { name: 'Chats' })

    fireEvent.click(header('Previous 7 days'))
    expect(header('Previous 7 days')).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('list', { name: 'Previous 7 days' })).not.toBeInTheDocument()
    expect(rowNames()).toEqual(['Fresh chat', 'Ancient'])
    expect(rendered.platform.storage.set).toHaveBeenLastCalledWith('chat.groups.folded', '["week"]')

    fireEvent.click(header('Previous 7 days'))
    expect(header('Previous 7 days')).toHaveAttribute('aria-expanded', 'true')
    expect(rendered.platform.storage.set).toHaveBeenLastCalledWith('chat.groups.folded', null)
  })

  it('still shows the open chat of a folded group, and only that one', async () => {
    const chats = [...dated, chat('c4', 'Also this week', { updatedAt: now - 2 * day })]
    showDated(chats, { lastRoute: 'chat/c2' })
    await screen.findByRole('list', { name: 'Chats' })

    fireEvent.click(header('Previous 7 days'))

    expect(rowNames()).toEqual(['Fresh chat', 'Mid week', 'Ancient'])
  })

  it.each([
    ['["older"]', ['Fresh chat', 'Mid week'], 'false'],
    ['not json', ['Fresh chat', 'Mid week', 'Ancient'], 'true']
  ])('starts from the stored folds %s', async (stored, names, expanded) => {
    showDated(dated, {}, { 'chat.groups.folded': stored })
    await screen.findByRole('list', { name: 'Chats' })

    expect(header('Older')).toHaveAttribute('aria-expanded', expanded)
    expect(rowNames()).toEqual(names)
  })

  it('shows search hits with no group headers', async () => {
    const rendered = showDated()
    await screen.findByRole('list', { name: 'Chats' })
    rendered.coreHttp.respond('GET', '/api/chats', (request) => ({
      body: {
        seq: 1,
        chats: new URL(request.url).searchParams.has('q') ? [dated[2]] : dated
      }
    }))
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
    vi.setSystemTime(now)

    fireEvent.click(screen.getByRole('button', { name: 'Search chats' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Search chats' }), { target: { value: 'anc' } })
    act(() => vi.advanceTimersByTime(200))

    await vi.waitFor(() => expect(rowNames()).toEqual(['Ancient']))
    expect(screen.queryByRole('button', { name: 'Older' })).not.toBeInTheDocument()
  })
})

describe('chat actions', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  async function openActions(title: string): Promise<HTMLElement> {
    fireEvent.click(await screen.findByRole('button', { name: `Actions for ${title}` }))
    return screen.findByRole('menu')
  }

  const itemNames = (menu: HTMLElement): string[] =>
    within(menu)
      .getAllByRole('menuitem')
      .map((item) => item.textContent ?? '')

  async function startRename(title: string): Promise<HTMLInputElement> {
    fireEvent.click(within(await openActions(title)).getByRole('menuitem', { name: 'Rename' }))
    return (await screen.findByRole('textbox', { name: 'Chat title' })) as HTMLInputElement
  }

  const patches = (rendered: ReturnType<typeof renderWithStore>): unknown[] =>
    coreWrites(rendered.coreHttp).filter((write) => write.method === 'PATCH')

  it('offers Rename, Export as Markdown and Delete from … and from a right-click', async () => {
    show([chat('c1', 'Trip to Cluj')])

    expect(itemNames(await openActions('Trip to Cluj'))).toEqual(['Rename', 'Export as Markdown', 'Delete'])
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument())

    fireEvent.contextMenu(row('Trip to Cluj'))
    expect(itemNames(await screen.findByRole('menu'))).toEqual(['Rename', 'Export as Markdown', 'Delete'])
  })

  it('puts one separator right before Delete in both menus', async () => {
    show([chat('c1', 'Trip to Cluj')])
    const beforeDelete = (menu: HTMLElement): void => {
      const separators = within(menu).getAllByRole('separator')
      expect(separators).toHaveLength(1)
      expect(
        separators[0].compareDocumentPosition(within(menu).getByRole('menuitem', { name: 'Delete' }))
      ).toBe(Node.DOCUMENT_POSITION_FOLLOWING)
      expect(itemNames(menu)).toEqual(['Rename', 'Export as Markdown', 'Delete'])
    }

    beforeDelete(await openActions('Trip to Cluj'))
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument())

    fireEvent.contextMenu(row('Trip to Cluj'))
    beforeDelete(await screen.findByRole('menu'))
  })

  it('keeps the separator before Delete on a host without files', async () => {
    show([chat('c1', 'Trip to Cluj')], {}, ['files'])
    const menu = await openActions('Trip to Cluj')

    const separator = within(menu).getByRole('separator')
    expect(separator.compareDocumentPosition(within(menu).getByRole('menuitem', { name: 'Delete' }))).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING
    )
    expect(itemNames(menu)).toEqual(['Rename', 'Delete'])
  })

  it('renames on Enter with the trimmed text', async () => {
    const rendered = show([chat('c1', 'Trip to Cluj')])
    rendered.coreHttp.respond('PATCH', '/api/chats/c1', () => ({
      body: { seq: 2, chat: chat('c1', 'Cluj in autumn', { titleSource: 'user' }) }
    }))
    const field = await startRename('Trip to Cluj')
    expect(field).toHaveValue('Trip to Cluj')
    await waitFor(() => expect(field).toHaveFocus())

    fireEvent.change(field, { target: { value: '  Cluj in autumn  ' } })
    fireEvent.keyDown(field, { key: 'Enter' })

    await waitFor(() =>
      expect(patches(rendered)).toEqual([
        { method: 'PATCH', path: '/api/chats/c1', body: { title: 'Cluj in autumn' } }
      ])
    )
    expect(row('Cluj in autumn')).toHaveFocus()
  })

  it.each([
    ['Esc', 'Cluj in autumn', 'Escape'],
    ['an empty text', '   ', 'Enter']
  ])('sends nothing on %s', async (_, text, key) => {
    const rendered = show([chat('c1', 'Trip to Cluj')])
    const field = await startRename('Trip to Cluj')

    fireEvent.change(field, { target: { value: text } })
    fireEvent.keyDown(field, { key })

    await waitFor(() => expect(row('Trip to Cluj')).toHaveFocus())
    expect(screen.queryByRole('textbox', { name: 'Chat title' })).not.toBeInTheDocument()
    expect(patches(rendered)).toEqual([])
  })

  it('puts the old title back when the rename fails', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const rendered = show([chat('c1', 'Trip to Cluj')])
    rendered.coreHttp.respond('PATCH', '/api/chats/c1', () => ({
      status: 500,
      body: { error: 'internal', message: 'disk full' }
    }))
    const field = await startRename('Trip to Cluj')

    fireEvent.change(field, { target: { value: 'Cluj in autumn' } })
    fireEvent.keyDown(field, { key: 'Enter' })

    await waitFor(() => expect(error).toHaveBeenCalledWith('Could not rename the chat', expect.anything()))
    expect(rowNames()).toEqual(['Trip to Cluj'])
  })

  it('exports through the host', async () => {
    const rendered = show([chat('c1', 'Trip to Cluj')])

    fireEvent.click(
      within(await openActions('Trip to Cluj')).getByRole('menuitem', { name: 'Export as Markdown' })
    )

    expect(rendered.platform.files.exportChat).toHaveBeenCalledWith('c1')
  })

  it('leaves Export out on a host without files', async () => {
    show([chat('c1', 'Trip to Cluj')], {}, ['files'])

    expect(itemNames(await openActions('Trip to Cluj'))).toEqual(['Rename', 'Delete'])
  })

  it('asks before deleting, and deletes only on Delete', async () => {
    const rendered = show([chat('c1', 'Trip to Cluj')])
    rendered.coreHttp.respond('DELETE', '/api/chats/c1', () => ({ status: 204 }))
    const deletes = (): unknown[] =>
      coreWrites(rendered.coreHttp).filter((write) => write.method === 'DELETE')

    fireEvent.click(within(await openActions('Trip to Cluj')).getByRole('menuitem', { name: 'Delete' }))
    const dialog = await screen.findByRole('dialog', { name: "Delete 'Trip to Cluj'?" })
    expect(within(dialog).getByText("This can't be undone.")).toBeInTheDocument()
    await waitFor(() => expect(within(dialog).getByRole('button', { name: 'Cancel' })).toHaveFocus())
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(deletes()).toEqual([])

    fireEvent.click(within(await openActions('Trip to Cluj')).getByRole('menuitem', { name: 'Delete' }))
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Delete' }))

    await waitFor(() =>
      expect(deletes()).toEqual([{ method: 'DELETE', path: '/api/chats/c1', body: undefined }])
    )
  })

  describe('search', () => {
    const hit = (id: string, title: string, snippet: ChatItem['snippet']): ChatItem =>
      chat(id, title, { snippet })

    function showSearch(): ReturnType<typeof renderWithStore> {
      const rendered = show([chat('c2', 'Rust lifetimes, again'), chat('c1', 'Trip to Cluj')])
      rendered.coreHttp.respond('GET', '/api/chats', (request) => {
        const q = new URL(request.url).searchParams.get('q')
        if (q === null) return { body: { seq: 1, chats: [chat('c2', 'Rust lifetimes, again')] } }
        if (q === 'quant') {
          return {
            body: {
              seq: 1,
              chats: [
                hit('c1', 'Models', [
                  { text: 'GGUF ', match: false },
                  { text: 'quant', match: true },
                  { text: 'ization', match: false }
                ]),
                hit('c3', 'Escapes', [{ text: 'use <b>x</b> here', match: false }])
              ]
            }
          }
        }
        return { body: { seq: 1, chats: [] } }
      })
      return rendered
    }

    const searches = (rendered: ReturnType<typeof renderWithStore>): (string | null)[] =>
      rendered.coreHttp.requests
        .map((request) => new URL(request.url))
        .filter((url) => url.pathname === '/api/chats')
        .map((url) => url.searchParams.get('q'))
    const field = (): HTMLElement => screen.getByRole('textbox', { name: 'Search chats' })
    const typeQuery = (text: string): void => {
      fireEvent.click(screen.getByRole('button', { name: 'Search chats' }))
      fireEvent.change(field(), { target: { value: text } })
    }

    afterEach(() => {
      vi.useRealTimers()
    })

    it('asks core once, 200 ms after typing, and marks the match in each hit', async () => {
      const rendered = showSearch()
      await screen.findByRole('list', { name: 'Chats' })
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })

      typeQuery('qua')
      fireEvent.change(field(), { target: { value: 'quant' } })
      act(() => vi.advanceTimersByTime(199))
      expect(searches(rendered)).not.toContain('quant')
      act(() => vi.advanceTimersByTime(1))

      // vi.waitFor, not findBy: Testing Library's async helpers wait on a timer that is faked here.
      await vi.waitFor(() => expect(screen.getByText('quant', { selector: 'mark' })).toBeInTheDocument())
      expect(searches(rendered).filter((q) => q === 'quant')).toHaveLength(1)
      expect(searches(rendered)).not.toContain('qua')
    })

    it('shows markup in a snippet as typed text', async () => {
      showSearch()
      await screen.findByRole('list', { name: 'Chats' })
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })

      typeQuery('quant')
      act(() => vi.advanceTimersByTime(200))

      await vi.waitFor(() => expect(screen.getByText('use <b>x</b> here')).toBeInTheDocument())
    })

    it('says so when nothing matches, and shows the full list again once cleared', async () => {
      const rendered = showSearch()
      await screen.findByRole('list', { name: 'Chats' })
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })

      typeQuery('zzz')
      act(() => vi.advanceTimersByTime(200))
      await vi.waitFor(() => expect(screen.getByText('No chats found')).toBeInTheDocument())

      const before = searches(rendered).length
      fireEvent.change(field(), { target: { value: '' } })
      act(() => vi.advanceTimersByTime(200))
      await vi.waitFor(() => expect(rowNames()).toEqual(['Rust lifetimes, again']))
      expect(searches(rendered).slice(before)).not.toContain('')
    })

    it('closes with Esc and returns focus to the search button', async () => {
      showSearch()
      await screen.findByRole('list', { name: 'Chats' })

      fireEvent.click(screen.getByRole('button', { name: 'Search chats' }))
      expect(field()).toHaveFocus()
      fireEvent.keyDown(field(), { key: 'Escape' })

      expect(screen.queryByRole('textbox', { name: 'Search chats' })).toBeNull()
      expect(screen.getByRole('button', { name: 'Search chats' })).toHaveFocus()
    })
  })
})
