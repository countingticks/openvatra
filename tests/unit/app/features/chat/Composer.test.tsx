import { createRef } from 'react'
import { act, fireEvent, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { Composer, type ComposerHandle } from '@app/features/chat/Composer'
import { renderWithStore } from '../../../renderWithStore'

function show(
  storage: Record<string, string> = {},
  onSend: (text: string, requestId: string, quotes: string[]) => Promise<void> = vi
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
  const chips = (): HTMLElement[] => screen.getAllByRole('group', { name: 'Quote' })
  const stored = (storage: Map<string, string>, key: string): unknown => {
    const raw = storage.get(key)
    return raw === undefined ? undefined : JSON.parse(raw)
  }

  it('quote shows a chip above the box and focuses it', () => {
    const { handle, platform } = show()

    act(() => handle.current?.quote('c1', 'some words'))

    expect(chips()[0]).toHaveTextContent('some words')
    expect(box()).toHaveFocus()
    expect(stored(platform.storage.values, 'chat.quotes:c1')).toEqual(['some words'])
    expect(handle.current?.quoteCount('c1')).toBe(1)
  })

  it('a second quote is added below the first', () => {
    const { handle } = show()

    act(() => handle.current?.quote('c1', 'one'))
    act(() => handle.current?.quote('c1', 'two'))

    expect(chips().map((c) => c.textContent)).toEqual(['one', 'two'])
  })

  it('the same text is not added twice', () => {
    const { handle } = show()

    act(() => handle.current?.quote('c1', 'one'))
    act(() => handle.current?.quote('c1', 'one'))

    expect(chips()).toHaveLength(1)
  })

  it('a sixth quote is not added', () => {
    const { handle } = show()

    for (const q of ['1', '2', '3', '4', '5', '6']) act(() => handle.current?.quote('c1', q))

    expect(chips().map((c) => c.textContent)).toEqual(['1', '2', '3', '4', '5'])
    expect(handle.current?.quoteCount('c1')).toBe(5)
  })

  it('x removes only its own chip', () => {
    const { handle, platform } = show()
    act(() => handle.current?.quote('c1', 'one'))
    act(() => handle.current?.quote('c1', 'two'))

    fireEvent.click(screen.getAllByRole('button', { name: 'Remove quote' })[0]!)

    expect(chips().map((c) => c.textContent)).toEqual(['two'])
    expect(stored(platform.storage.values, 'chat.quotes:c1')).toEqual(['two'])
    expect(box()).toHaveFocus()
  })

  it('Remove quote clears the chip and its storage', () => {
    const { handle, platform } = show()
    act(() => handle.current?.quote('c1', 'one'))

    fireEvent.click(screen.getByRole('button', { name: 'Remove quote' }))

    expect(screen.queryByRole('group', { name: 'Quote' })).toBeNull()
    expect(platform.storage.values.has('chat.quotes:c1')).toBe(false)
  })

  it("the quotes are kept per chat: another chat's storage is written, the shown chips are untouched", () => {
    const { handle, platform } = show({ 'chat.quotes:c1': JSON.stringify(['mine']) })

    act(() => handle.current?.quote('c2', 'theirs'))

    expect(stored(platform.storage.values, 'chat.quotes:c2')).toEqual(['theirs'])
    expect(handle.current?.quoteCount('c2')).toBe(1)
    expect(chips().map((c) => c.textContent)).toEqual(['mine'])
  })

  it('a stored value that is not a list reads as no quotes', () => {
    show({ 'chat.quotes:c1': '{"a":1}' })

    expect(screen.queryByRole('group', { name: 'Quote' })).toBeNull()
  })

  it('send passes the quotes and clears them once accepted; a failed send keeps them', async () => {
    const onSend = vi
      .fn<(text: string, requestId: string, quotes: string[]) => Promise<void>>()
      .mockRejectedValueOnce(new Error('no'))
      .mockResolvedValue(undefined)
    const { handle, platform } = show({}, onSend)
    act(() => handle.current?.quote('c1', 'q'))
    fireEvent.change(box(), { target: { value: 'Explain' } })

    fireEvent.keyDown(box(), { key: 'Enter' })
    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument())
    expect(chips()[0]).toHaveTextContent('q')
    expect(box()).toHaveValue('Explain')

    fireEvent.keyDown(box(), { key: 'Enter' })
    await waitFor(() => expect(screen.queryByRole('group', { name: 'Quote' })).toBeNull())
    expect(onSend).toHaveBeenLastCalledWith('Explain', expect.any(String), ['q'])
    expect(box()).toHaveValue('')
    expect(platform.storage.values.has('chat.quotes:c1')).toBe(false)
  })

  it('a quote with an empty box shows no Send', () => {
    const { handle } = show()

    act(() => handle.current?.quote('c1', 'q'))

    expect(screen.queryByRole('button', { name: 'Send (Enter)' })).toBeNull()
  })

  it('fill replaces the quotes, and without any clears them', () => {
    const { handle } = show({ 'chat.quotes:c1': JSON.stringify(['old']) })

    act(() => handle.current?.fill('c1', 'text', ['new', 'newer']))
    expect(chips().map((c) => c.textContent)).toEqual(['new', 'newer'])

    act(() => handle.current?.fill('c1', 'text'))
    expect(screen.queryByRole('group', { name: 'Quote' })).toBeNull()
  })
})
