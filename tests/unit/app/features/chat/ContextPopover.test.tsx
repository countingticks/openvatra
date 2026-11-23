import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { ContextUse } from '@app/core/generated'
import { ContextPopover } from '@app/features/chat/ContextPopover'
import { renderWithStore } from '../../../renderWithStore'

const context: ContextUse = {
  used: 3140,
  size: 32768,
  parts: { system: 900, messages: 2240, messageCount: 6, search: 0, files: 0 }
}

describe('ContextPopover', () => {
  it.each([
    ['no context', null],
    ['a size of 0', { ...context, size: 0 }]
  ])('renders nothing for %s', (_case, value) => {
    const { container } = renderWithStore(<ContextPopover context={value} />)

    expect(container).toBeEmptyDOMElement()
  })

  it('shows the use on its button, opens a dialog with the parts, and closes with Esc', async () => {
    renderWithStore(<ContextPopover context={context} />)
    const button = screen.getByRole('button', { name: 'Context: 3,140 of 32,768 tokens used. Show details' })
    expect(button).toHaveTextContent('3.1k / 32k')

    fireEvent.click(button)
    const dialog = await screen.findByRole('dialog', { name: 'Context usage' })

    expect(within(dialog).getByRole('heading', { level: 2, name: 'Context' })).toBeInTheDocument()
    for (const text of ['System prompt', '900', 'Messages (6)', '2,240', 'Free', '29,628'])
      expect(within(dialog).getByText(text)).toBeInTheDocument()

    fireEvent.keyDown(dialog, { key: 'Escape' })
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Context usage' })).not.toBeInTheDocument()
    )
  })
})
