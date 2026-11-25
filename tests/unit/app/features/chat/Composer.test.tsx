import { createRef } from 'react'
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { Quote } from '@app/core/generated'
import { Composer, type ComposerHandle } from '@app/features/chat/Composer'
import { renderWithStore } from '../../../renderWithStore'

function show(
  storage: Record<string, string> = {},
  onSend: (text: string, requestId: string, quotes: Quote[]) => Promise<void> = vi
    .fn()
    .mockResolvedValue(undefined)
): ReturnType<typeof renderWithStore> & {
  handle: React.RefObject<ComposerHandle | null>
} {
  const handle = createRef<ComposerHandle>()
  const rendered = renderWithStore(
    <Composer chatId="c1" answering={false} onSend={onSend} onStop={vi.fn()} footer={null} ref={handle} />,
    {},
    { storage }
  )
  return { ...rendered, handle }
}

const box = (): HTMLTextAreaElement => screen.getByRole('textbox', { name: 'Message' })

describe('Composer fill', () => {
  it('puts the text in an empty box, focused with the cursor at the end', () => {
    const { handle } = show()

    act(() => handle.current?.fill('c1', 'earlier'))

    expect(box()).toHaveValue('earlier')
    expect(box()).toHaveFocus()
    expect(box().selectionStart).toBe('earlier'.length)
    expect(box().selectionEnd).toBe('earlier'.length)
  })

  it('replaces a draft, discarding it', () => {
    const { handle, platform } = show({ 'chat.draft:c1': 'later' })

    act(() => handle.current?.fill('c1', 'earlier'))

    expect(box()).toHaveValue('earlier')
    expect(platform.storage.values.get('chat.draft:c1')).toBe('earlier')
  })

  it("for another chat changes only that chat's stored draft", () => {
    const { handle, platform } = show({ 'chat.draft:c2': 'y' })

    act(() => handle.current?.fill('c2', 'x'))

    expect(platform.storage.values.get('chat.draft:c2')).toBe('x')
    expect(box()).toHaveValue('')
  })
})

describe('Composer quote', () => {
  const cards = (): HTMLElement[] => screen.getAllByRole('group', { name: 'Quote' })
  const texts = (): (string | null)[] => cards().map((c) => c.querySelector('span')?.textContent ?? null)
  const stored = (storage: Map<string, string>, key: string): unknown => {
    const raw = storage.get(key)
    return raw === undefined ? undefined : JSON.parse(raw)
  }

  it('quote shows a card above the box and focuses it', () => {
    const { handle, platform } = show()

    act(() => handle.current?.quote('c1', { text: 'some words' }))

    expect(cards()[0]).toHaveTextContent('some words')
    expect(box()).toHaveFocus()
    expect(stored(platform.storage.values, 'chat.quotes:c1')).toEqual([{ text: 'some words' }])
  })

  it('a second quote is added below the first', () => {
    const { handle } = show()

    act(() => handle.current?.quote('c1', { text: 'one' }))
    act(() => handle.current?.quote('c1', { text: 'two' }))

    expect(texts()).toEqual(['“one”', '“two”'])
  })

  it('the same text is not added twice', () => {
    const { handle } = show()

    act(() => handle.current?.quote('c1', { text: 'one' }))
    act(() => handle.current?.quote('c1', { text: 'one' }))

    expect(cards()).toHaveLength(1)
  })

  it('a sixth quote is added', () => {
    const { handle } = show()

    for (const q of ['1', '2', '3', '4', '5', '6']) act(() => handle.current?.quote('c1', { text: q }))

    expect(texts()).toEqual(['“1”', '“2”', '“3”', '“4”', '“5”', '“6”'])
  })

  it('x removes only its own chip', () => {
    const { handle, platform } = show()
    act(() => handle.current?.quote('c1', { text: 'one' }))
    act(() => handle.current?.quote('c1', { text: 'two' }))

    fireEvent.click(screen.getAllByRole('button', { name: 'Remove quote' })[0]!)

    expect(texts()).toEqual(['“two”'])
    expect(stored(platform.storage.values, 'chat.quotes:c1')).toEqual([{ text: 'two' }])
    expect(box()).toHaveFocus()
  })

  it('Remove quote clears the card and its storage', () => {
    const { handle, platform } = show()
    act(() => handle.current?.quote('c1', { text: 'one' }))

    fireEvent.click(screen.getByRole('button', { name: 'Remove quote' }))

    expect(screen.queryByRole('group', { name: 'Quote' })).toBeNull()
    expect(platform.storage.values.has('chat.quotes:c1')).toBe(false)
  })

  it("the quotes are kept per chat: another chat's storage is written, the shown cards are untouched", () => {
    const { handle, platform } = show({ 'chat.quotes:c1': JSON.stringify([{ text: 'mine' }]) })

    act(() => handle.current?.quote('c2', { text: 'theirs' }))

    expect(stored(platform.storage.values, 'chat.quotes:c2')).toEqual([{ text: 'theirs' }])
    expect(texts()).toEqual(['“mine”'])
  })

  it('a stored value that is not a list reads as no quotes', () => {
    show({ 'chat.quotes:c1': '{"a":1}' })

    expect(screen.queryByRole('group', { name: 'Quote' })).toBeNull()
  })

  it('a stored list of strings reads as quotes without replies', () => {
    show({ 'chat.quotes:c1': JSON.stringify(['one', 'two']) })

    expect(texts()).toEqual(['“one”', '“two”'])
    expect(screen.queryByText('With reply')).toBeNull()
  })

  it('a replied quote shows With reply, an unreplied one does not', () => {
    const { handle } = show()

    act(() => handle.current?.quote('c1', { text: 'one', reply: 'why' }))
    act(() => handle.current?.quote('c1', { text: 'two' }))

    expect(screen.getAllByText('With reply')).toHaveLength(1)
    expect(within(cards()[0]!).getByText('With reply')).toBeInTheDocument()
  })

  it('a replied quote with an empty box shows Send and sends', async () => {
    const onSend = vi.fn<(text: string, requestId: string, quotes: Quote[]) => Promise<void>>()
    onSend.mockResolvedValue(undefined)
    const { handle } = show({}, onSend)
    act(() => handle.current?.quote('c1', { text: 'q', reply: 'why' }))

    fireEvent.click(screen.getByRole('button', { name: 'Send (Enter)' }))

    await waitFor(() =>
      expect(onSend).toHaveBeenCalledWith('', expect.any(String), [{ text: 'q', reply: 'why' }])
    )
  })

  it('send passes the quotes and clears them once accepted; a failed send keeps them', async () => {
    const onSend = vi
      .fn<(text: string, requestId: string, quotes: Quote[]) => Promise<void>>()
      .mockRejectedValueOnce(new Error('no'))
      .mockResolvedValue(undefined)
    const { handle, platform } = show({}, onSend)
    act(() => handle.current?.quote('c1', { text: 'q' }))
    fireEvent.change(box(), { target: { value: 'Explain' } })

    fireEvent.keyDown(box(), { key: 'Enter' })
    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument())
    expect(cards()[0]).toHaveTextContent('q')
    expect(box()).toHaveValue('Explain')

    fireEvent.keyDown(box(), { key: 'Enter' })
    await waitFor(() => expect(screen.queryByRole('group', { name: 'Quote' })).toBeNull())
    expect(onSend).toHaveBeenLastCalledWith('Explain', expect.any(String), [{ text: 'q' }])
    expect(box()).toHaveValue('')
    expect(platform.storage.values.has('chat.quotes:c1')).toBe(false)
  })

  it('an unreplied quote with an empty box shows no Send', () => {
    const { handle } = show()

    act(() => handle.current?.quote('c1', { text: 'q' }))

    expect(screen.queryByRole('button', { name: 'Send (Enter)' })).toBeNull()
  })

  it('fill replaces the quotes, and without any clears them', () => {
    const { handle } = show({ 'chat.quotes:c1': JSON.stringify([{ text: 'old' }]) })

    act(() => handle.current?.fill('c1', 'text', [{ text: 'new' }, { text: 'newer' }]))
    expect(texts()).toEqual(['“new”', '“newer”'])

    act(() => handle.current?.fill('c1', 'text'))
    expect(screen.queryByRole('group', { name: 'Quote' })).toBeNull()
  })
})
