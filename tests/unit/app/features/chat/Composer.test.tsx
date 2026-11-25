import { createRef } from 'react'
import { act, fireEvent, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { Composer, type ComposerHandle } from '@app/features/chat/Composer'
import { renderWithStore } from '../../../renderWithStore'

function show(
  storage: Record<string, string> = {},
  onSend: (text: string, requestId: string, quote: string | null) => Promise<void> = vi
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
  const chip = (): HTMLElement => screen.getByRole('group', { name: 'Quote' })

  it('quote shows a chip above the box and focuses it', () => {
    const { handle, platform } = show()

    act(() => handle.current?.quote('c1', 'some words'))

    expect(chip()).toHaveTextContent('some words')
    expect(box()).toHaveFocus()
    expect(platform.storage.values.get('chat.quote:c1')).toBe('some words')
  })

  it('a second quote replaces the first', () => {
    const { handle } = show()

    act(() => handle.current?.quote('c1', 'one'))
    act(() => handle.current?.quote('c1', 'two'))

    expect(chip()).toHaveTextContent('two')
    expect(screen.getAllByRole('group', { name: 'Quote' })).toHaveLength(1)
  })

  it('Remove quote clears the chip and its storage', () => {
    const { handle, platform } = show()
    act(() => handle.current?.quote('c1', 'one'))

    fireEvent.click(screen.getByRole('button', { name: 'Remove quote' }))

    expect(screen.queryByRole('group', { name: 'Quote' })).toBeNull()
    expect(platform.storage.values.has('chat.quote:c1')).toBe(false)
    expect(box()).toHaveFocus()
  })

  it("the quote is kept per chat: another chat's storage is written, the shown chip is untouched", () => {
    const { handle, platform } = show({ 'chat.quote:c1': 'mine' })

    act(() => handle.current?.quote('c2', 'theirs'))

    expect(platform.storage.values.get('chat.quote:c2')).toBe('theirs')
    expect(chip()).toHaveTextContent('mine')
  })

  it('send passes the quote and clears it once accepted; a failed send keeps it', async () => {
    const onSend = vi
      .fn<(text: string, requestId: string, quote: string | null) => Promise<void>>()
      .mockRejectedValueOnce(new Error('no'))
      .mockResolvedValue(undefined)
    const { handle, platform } = show({}, onSend)
    act(() => handle.current?.quote('c1', 'q'))
    fireEvent.change(box(), { target: { value: 'Explain' } })

    fireEvent.keyDown(box(), { key: 'Enter' })
    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument())
    expect(chip()).toHaveTextContent('q')
    expect(box()).toHaveValue('Explain')

    fireEvent.keyDown(box(), { key: 'Enter' })
    await waitFor(() => expect(screen.queryByRole('group', { name: 'Quote' })).toBeNull())
    expect(onSend).toHaveBeenLastCalledWith('Explain', expect.any(String), 'q')
    expect(box()).toHaveValue('')
    expect(platform.storage.values.has('chat.quote:c1')).toBe(false)
  })

  it('a quote with an empty box shows no Send', () => {
    const { handle } = show()

    act(() => handle.current?.quote('c1', 'q'))

    expect(screen.queryByRole('button', { name: 'Send (Enter)' })).toBeNull()
  })

  it('fill replaces the quote, and without one clears it', () => {
    const { handle } = show({ 'chat.quote:c1': 'old' })

    act(() => handle.current?.fill('c1', 'text', 'new'))
    expect(chip()).toHaveTextContent('new')

    act(() => handle.current?.fill('c1', 'text'))
    expect(screen.queryByRole('group', { name: 'Quote' })).toBeNull()
  })
})
