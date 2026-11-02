import { act, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { backdropFrameMs, PixelBackdrop } from '@renderer/components/PixelBackdrop'

// jsdom can't draw, so the component gets a fake 2D context that records what it's asked to do.
function fakeContext(): { putImageData: ReturnType<typeof vi.fn>; fillRect: ReturnType<typeof vi.fn> } {
  const context = {
    fillStyle: '',
    clearRect: vi.fn(),
    fillRect: vi.fn(),
    getImageData: () => ({ data: new Uint8ClampedArray([24, 24, 27, 255]) }),
    createImageData: (width: number, height: number) => ({
      width,
      height,
      data: new Uint8ClampedArray(width * height * 4)
    }),
    putImageData: vi.fn()
  }
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
    context as unknown as CanvasRenderingContext2D
  )
  return context
}

function setVisibility(state: DocumentVisibilityState): void {
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue(state)
  act(() => {
    document.dispatchEvent(new Event('visibilitychange'))
  })
}

function advance(ms: number): void {
  act(() => {
    vi.advanceTimersByTime(ms)
  })
}

let context: ReturnType<typeof fakeContext>

beforeEach(() => {
  vi.useFakeTimers()
  context = fakeContext()
  // jsdom does no layout; pretend the conversation area is 400×300 screen pixels.
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(400)
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(300)
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

const draws = (): number => context.putImageData.mock.calls.length

describe('PixelBackdrop', () => {
  it('is decoration only: hidden from assistive technology and never catches the mouse', () => {
    const { container } = render(<PixelBackdrop />)
    const canvas = container.querySelector('canvas')

    expect(canvas).toHaveAttribute('aria-hidden', 'true')
    expect(canvas).toHaveClass('pointer-events-none')
  })

  it('draws at a quarter of the screen resolution, so each pixel is a crisp 4×4 block', () => {
    const { container } = render(<PixelBackdrop />)
    const canvas = container.querySelector('canvas') as HTMLCanvasElement

    expect(canvas.width).toBe(100)
    expect(canvas.height).toBe(75)
  })

  it('draws at once, then about 12 times a second', () => {
    render(<PixelBackdrop />)
    expect(draws()).toBe(1)

    advance(backdropFrameMs)
    expect(draws()).toBe(2)

    advance(1000)
    expect(draws()).toBe(2 + Math.floor(1000 / backdropFrameMs))
  })

  it('stops drawing while the window is hidden, and picks up again when shown', () => {
    render(<PixelBackdrop />)
    advance(backdropFrameMs)

    setVisibility('hidden')
    const whileHidden = draws()
    advance(5000)
    expect(draws()).toBe(whileHidden)

    setVisibility('visible')
    advance(backdropFrameMs)
    expect(draws()).toBe(whileHidden + 1)
  })

  it('does not start a timer at all if the window opens hidden (started with Windows, in the tray)', () => {
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
    render(<PixelBackdrop />)

    expect(vi.getTimerCount()).toBe(0)
  })

  it('redraws in the new theme’s colours when the theme changes', async () => {
    render(<PixelBackdrop />)
    const before = draws()

    document.documentElement.classList.add('dark')
    // MutationObserver reports after the current task; let it run.
    await act(async () => {})
    document.documentElement.classList.remove('dark')
    await act(async () => {})

    expect(draws()).toBe(before + 2)
  })

  it('leaves nothing running when removed', () => {
    const { unmount } = render(<PixelBackdrop />)

    unmount()

    expect(vi.getTimerCount()).toBe(0)
  })

  it('shows one still frame with reduced motion', () => {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query === '(prefers-reduced-motion: reduce)',
      addEventListener: () => {},
      removeEventListener: () => {}
    }))
    render(<PixelBackdrop />)

    advance(5000)

    expect(draws()).toBe(1)
    expect(vi.getTimerCount()).toBe(0)
  })
})
