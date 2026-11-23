import { useRef } from 'react'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useFollowEnd } from '@app/features/chat/useFollowEnd'

function Conversation({ chatId }: { chatId: string | undefined }): React.JSX.Element {
  const scroller = useRef<HTMLDivElement>(null)
  const { following, showLatest, jumpToLatest } = useFollowEnd(scroller, chatId)
  return (
    <>
      <div ref={scroller} role="log" aria-label="Conversation">
        <div>messages</div>
      </div>
      <span role="status">{following ? 'following' : 'reading'}</span>
      {showLatest && (
        <button type="button" onClick={jumpToLatest}>
          Scroll to latest
        </button>
      )}
    </>
  )
}

let grew: () => void = () => {}

beforeEach(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(callback: () => void) {
        grew = () => act(() => callback())
      }
      observe = vi.fn()
      disconnect = vi.fn()
    }
  )
})

const log = (): HTMLElement => screen.getByRole('log', { name: 'Conversation' })

/** Gives the log a layout jsdom does not have: its content height and its visible height. */
function layout(scrollHeight: number, clientHeight = 200): void {
  Object.defineProperty(log(), 'scrollHeight', { value: scrollHeight, configurable: true })
  Object.defineProperty(log(), 'clientHeight', { value: clientHeight, configurable: true })
}

function scrollTo(top: number): void {
  log().scrollTop = top
  fireEvent.scroll(log())
}

describe('useFollowEnd', () => {
  it('scrolls to the end when the content grows while at the end', () => {
    render(<Conversation chatId="c1" />)
    layout(1000)
    scrollTo(800)

    layout(1500)
    grew()

    expect(log().scrollTop).toBe(1500)
    expect(screen.queryByRole('button', { name: 'Scroll to latest' })).not.toBeInTheDocument()
  })

  it('keeps the place after scrolling up, until jumping to the latest', () => {
    render(<Conversation chatId="c1" />)
    layout(1000)
    scrollTo(500)

    layout(1500)
    grew()

    expect(log().scrollTop).toBe(500)
    fireEvent.click(screen.getByRole('button', { name: 'Scroll to latest' }))
    expect(log().scrollTop).toBe(1500)
    expect(screen.queryByRole('button', { name: 'Scroll to latest' })).not.toBeInTheDocument()
  })

  it('offers the button only once scrolled up past 0.6 of the view', () => {
    render(<Conversation chatId="c1" />)
    layout(1000)

    // 0.5 of the 200 px view: no longer following, but not far enough for the button.
    scrollTo(700)
    expect(screen.getByRole('status')).toHaveTextContent('reading')
    expect(screen.queryByRole('button', { name: 'Scroll to latest' })).not.toBeInTheDocument()

    scrollTo(660)
    expect(screen.getByRole('button', { name: 'Scroll to latest' })).toBeInTheDocument()
  })

  it('shows the button when content grows under a reader who is scrolled up', () => {
    render(<Conversation chatId="c1" />)
    layout(1000)
    scrollTo(700)
    expect(screen.queryByRole('button', { name: 'Scroll to latest' })).not.toBeInTheDocument()

    layout(1100)
    grew()

    expect(screen.getByRole('button', { name: 'Scroll to latest' })).toBeInTheDocument()
  })

  it('jumps to the end of another chat', () => {
    const { rerender } = render(<Conversation chatId="c1" />)
    layout(1000)
    scrollTo(100)
    expect(screen.getByRole('button', { name: 'Scroll to latest' })).toBeInTheDocument()

    layout(3000)
    rerender(<Conversation chatId="c2" />)

    expect(log().scrollTop).toBe(3000)
    expect(screen.queryByRole('button', { name: 'Scroll to latest' })).not.toBeInTheDocument()
  })
})
