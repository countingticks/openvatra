import { act, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Ember } from '@renderer/components/Ember'

// The drawn pixels, so tests can tell whether the frame changed.
const pixels = (): string => screen.getByRole('img').innerHTML

/** Moves the fake clock forward and lets React apply the resulting updates. */
function advance(ms: number): void {
  act(() => {
    vi.advanceTimersByTime(ms)
  })
}

function preferReducedMotion(): void {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query === '(prefers-reduced-motion: reduce)',
    addEventListener: () => {},
    removeEventListener: () => {}
  }))
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('Ember', () => {
  it('is an image named after its state', () => {
    render(<Ember state="idle" />)

    expect(screen.getByRole('img', { name: 'Ember, idle' })).toBeInTheDocument()
  })

  it('draws crisp 16×16 pixel art at a whole-number scale', () => {
    render(<Ember state="idle" scale={3} />)
    const svg = screen.getByRole('img')

    expect(svg).toHaveAttribute('viewBox', '0 0 16 16')
    expect(svg).toHaveAttribute('width', '48')
    expect(svg).toHaveAttribute('shape-rendering', 'crispEdges')
    expect(svg.querySelectorAll('rect').length).toBeGreaterThan(0)
  })

  it('moves to the next frame every 100 ms', () => {
    render(<Ember state="idle" />)
    const first = pixels()

    advance(99)
    expect(pixels()).toBe(first)

    // idle's first frames differ, so a tick must change the drawing.
    advance(1)
    advance(100)
    expect(pixels()).not.toBe(first)
  })

  it('loops idle forever: after a full 7.2 s cycle it is back on its first frame', () => {
    render(<Ember state="idle" />)
    const first = pixels()

    advance(7200)

    expect(pixels()).toBe(first)
    expect(screen.getByRole('img')).toHaveAccessibleName('Ember, idle')
  })

  it('plays success once (2 s), then hands over to idle', () => {
    render(<Ember state="success" />)

    advance(1900)
    expect(screen.getByRole('img')).toHaveAccessibleName('Ember, success')

    advance(100)
    expect(screen.getByRole('img')).toHaveAccessibleName('Ember, idle')
  })

  it('keeps an error looping after its intro instead of ending', () => {
    render(<Ember state="error" />)

    advance(30_000)

    expect(screen.getByRole('img')).toHaveAccessibleName('Ember, error')
  })

  it('restarts when the parent gives it a new state', () => {
    const { rerender } = render(<Ember state="idle" />)
    advance(500)

    rerender(<Ember state="thinking" />)

    expect(screen.getByRole('img')).toHaveAccessibleName('Ember, thinking')
  })

  it('stops its timer when removed', () => {
    const { unmount } = render(<Ember state="idle" />)

    unmount()

    expect(vi.getTimerCount()).toBe(0)
  })

  it('blinks at a random moment 6–10 s in, not on a fixed beat', () => {
    // Two Embers, same clock: one told to blink as early as allowed (6 s), one as late (10 s).
    vi.spyOn(Math, 'random').mockReturnValue(0)
    const early = render(<Ember state="idle" />).container
    vi.spyOn(Math, 'random').mockReturnValue(0.9999)
    const late = render(<Ember state="idle" />).container

    advance(5900)
    expect(early.innerHTML).toBe(late.innerHTML)

    advance(100)
    expect(early.innerHTML).not.toBe(late.innerHTML)

    // After its three blink frames, the early one has its eyes open again: both match.
    advance(300)
    expect(early.innerHTML).toBe(late.innerHTML)
  })

  describe('loading', () => {
    it('says how far along it is', () => {
      render(<Ember state="loading" progress={0.4} />)

      expect(screen.getByRole('img')).toHaveAccessibleName('Ember, loading 40%')
    })

    it('keeps playing when progress moves on, instead of starting over', () => {
      const { rerender } = render(<Ember state="loading" progress={0.4} />)
      advance(300)
      const before = pixels()

      rerender(<Ember state="loading" progress={0.4} />)
      expect(pixels()).toBe(before)

      rerender(<Ember state="loading" progress={0.5} />)
      expect(screen.getByRole('img')).toHaveAccessibleName('Ember, loading 50%')
    })

    it('lights more of the line as progress grows', () => {
      const { container: low } = render(<Ember state="loading" progress={0.1} />)
      const { container: high } = render(<Ember state="loading" progress={0.9} />)

      expect(low.innerHTML).not.toBe(high.innerHTML)
    })

    it('bursts at 100%, then settles into idle', () => {
      render(<Ember state="loading" progress={1} />)
      expect(screen.getByRole('img')).toHaveAccessibleName('Ember, ready')

      advance(400)

      expect(screen.getByRole('img')).toHaveAccessibleName('Ember, idle')
    })
  })

  describe('with reduced motion', () => {
    beforeEach(preferReducedMotion)

    it('still shows loading progress: it is information, not motion', () => {
      const { container: low } = render(<Ember state="loading" progress={0.1} />)
      const { container: high } = render(<Ember state="loading" progress={0.9} />)

      expect(low.innerHTML).not.toBe(high.innerHTML)
    })

    it('never blinks', () => {
      vi.spyOn(Math, 'random').mockReturnValue(0)
      render(<Ember state="idle" />)
      const first = pixels()

      advance(6000)

      expect(pixels()).toBe(first)
    })

    it('holds its first frame', () => {
      render(<Ember state="idle" />)
      const first = pixels()

      advance(5000)

      expect(pixels()).toBe(first)
    })

    it('still hands a one-shot over when it would have ended', () => {
      render(<Ember state="success" />)

      advance(2000)

      expect(screen.getByRole('img')).toHaveAccessibleName('Ember, idle')
    })
  })
})
