import { useEffect, useRef } from 'react'
import { usePrefersReducedMotion } from '@renderer/hooks/usePrefersReducedMotion'
import { backdropPixelSize, drawBackdrop, driftPerSecond, type Rgb } from '@renderer/backdrop/pattern'

/** About 12 frames a second: plenty for a drift this slow, and light on the CPU. */
export const backdropFrameMs = 80

const toneTokens = ['--backdrop-1', '--backdrop-2', '--backdrop-3', '--backdrop-4']

/**
 * The theme's backdrop tones as RGB. The tokens are oklch, but pixel buffers need RGB, so each color is painted
 * onto a 1×1 canvas and read back: the browser does the conversion.
 */
function readTones(element: Element): Rgb[] | undefined {
  const styles = getComputedStyle(element)
  const probe = document.createElement('canvas').getContext('2d', { willReadFrequently: true })
  if (!probe) return undefined
  return toneTokens.map((token) => {
    probe.clearRect(0, 0, 1, 1)
    probe.fillStyle = styles.getPropertyValue(token).trim()
    probe.fillRect(0, 0, 1, 1)
    const [r, g, b] = probe.getImageData(0, 0, 1, 1).data
    return [r, g, b] as const
  })
}

/**
 * A quiet, slowly drifting pixel texture behind the conversation (design decision). Decorative only: hidden
 * from assistive technology, never catches the mouse, still with reduced motion, paused while the window is
 * hidden.
 */
export function PixelBackdrop(): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const reducedMotion = usePrefersReducedMotion()

  useEffect(() => {
    const canvas = canvasRef.current
    const context = canvas?.getContext('2d')
    if (!canvas || !context) return

    let tones = readTones(canvas)
    let image: ImageData | undefined
    const startedAt = performance.now()

    function draw(): void {
      if (!canvas || !context || !tones) return
      const width = Math.ceil(canvas.clientWidth / backdropPixelSize)
      const height = Math.ceil(canvas.clientHeight / backdropPixelSize)
      if (width === 0 || height === 0) return
      // A new buffer only when the size changes, not every frame.
      if (!image || image.width !== width || image.height !== height) {
        canvas.width = width
        canvas.height = height
        image = context.createImageData(width, height)
      }
      const seconds = (performance.now() - startedAt) / 1000
      drawBackdrop(image.data, width, height, seconds * driftPerSecond, tones)
      context.putImageData(image, 0, 0)
    }

    let timer: ReturnType<typeof setInterval> | undefined
    const stop = (): void => {
      clearInterval(timer)
      timer = undefined
    }
    const run = (): void => {
      if (reducedMotion || timer !== undefined || document.visibilityState === 'hidden') return
      timer = setInterval(draw, backdropFrameMs)
    }
    // Hidden to the tray: no one can see it, so stop drawing entirely.
    const onVisibilityChange = (): void => {
      if (document.visibilityState === 'hidden') stop()
      else run()
    }

    // The theme switches by changing the class on <html>; read the tones again so the colors follow it.
    const themeWatcher = new MutationObserver(() => {
      tones = readTones(canvas)
      draw()
    })
    themeWatcher.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
    // A resize would otherwise stretch the old frame until the next tick (or forever with reduced motion).
    const resizeWatcher = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(draw)
    resizeWatcher?.observe(canvas)
    document.addEventListener('visibilitychange', onVisibilityChange)

    draw()
    run()
    return () => {
      stop()
      themeWatcher.disconnect()
      resizeWatcher?.disconnect()
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  }, [reducedMotion])

  // Window-wide and pinned to the right edge, not sized to its container: while the sidebar slides, the container
  // changes width every frame, which would resize, clear and redraw the canvas each time (stutter, and a pattern
  // that shifts). This way the sidebar just covers and uncovers a still backdrop; the parent clips the overflow.
  return (
    <canvas
      ref={canvasRef}
      aria-hidden
      className="pointer-events-none absolute inset-y-0 right-0 h-full w-screen [image-rendering:pixelated]"
    />
  )
}
