import { createRef } from 'react'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OverlayScroll } from '@app/ui/OverlayScroll'

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

function setup(): { root: HTMLElement; log: HTMLElement } {
  const ref = createRef<HTMLDivElement>()
  const { container } = render(
    <OverlayScroll
      viewport={{ ref, role: 'log', 'aria-label': 'Conversation' }}
      overlay={<button>Over</button>}
    >
      <p>Hello</p>
    </OverlayScroll>
  )
  const log = screen.getByRole('log', { name: 'Conversation' })
  expect(ref.current).toBe(log)
  return { root: container.firstElementChild as HTMLElement, log }
}

const visible = (root: HTMLElement): boolean => root.hasAttribute('data-visible')

describe('OverlayScroll', () => {
  it('renders its children in the viewport and the overlay outside it', () => {
    const { log } = setup()
    expect(log).toContainElement(screen.getByText('Hello'))
    expect(log).not.toContainElement(screen.getByRole('button', { name: 'Over' }))
  })

  it('shows while scrolling and 600 ms after the last scroll', () => {
    const { root, log } = setup()
    fireEvent.scroll(log)
    expect(visible(root)).toBe(true)
    act(() => vi.advanceTimersByTime(400))
    fireEvent.scroll(log)
    act(() => vi.advanceTimersByTime(599))
    expect(visible(root)).toBe(true)
    act(() => vi.advanceTimersByTime(1))
    expect(visible(root)).toBe(false)
  })

  it('shows while hovered and 600 ms after the pointer leaves', () => {
    const { root } = setup()
    fireEvent.pointerEnter(root)
    act(() => vi.advanceTimersByTime(5000))
    expect(visible(root)).toBe(true)
    fireEvent.pointerLeave(root)
    act(() => vi.advanceTimersByTime(599))
    expect(visible(root)).toBe(true)
    act(() => vi.advanceTimersByTime(1))
    expect(visible(root)).toBe(false)
  })
})
