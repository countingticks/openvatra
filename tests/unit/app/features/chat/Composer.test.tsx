import { createRef } from 'react'
import { act, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { Composer, type ComposerHandle } from '@app/features/chat/Composer'
import { renderWithStore } from '../../../renderWithStore'

function show(storage: Record<string, string> = {}): ReturnType<typeof renderWithStore> & {
  handle: React.RefObject<ComposerHandle | null>
} {
  const handle = createRef<ComposerHandle>()
  const rendered = renderWithStore(
    <Composer
      chatId="c1"
      answering={false}
      onSend={vi.fn().mockResolvedValue(undefined)}
      onStop={vi.fn()}
      footer={null}
      ref={handle}
    />,
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
