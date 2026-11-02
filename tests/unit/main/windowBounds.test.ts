// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { safeWindowBounds, windowDefaultSize, type Rect } from '../../../src/main/windowBounds'

// Work areas as Electron reports them: DIPs, taskbar (48 px at the bottom) already excluded.
const laptop: Rect = { x: 0, y: 0, width: 1920, height: 1032 }
// A second monitor to the right of the laptop.
const rightMonitor: Rect = { x: 1920, y: 0, width: 2560, height: 1392 }
// 1920×1080 at 150 % scaling is 1280×720 DIPs, minus a 32 DIP taskbar.
const scaled150: Rect = { x: 0, y: 0, width: 1280, height: 688 }

describe('safeWindowBounds', () => {
  it('centers the default size on the primary display when nothing is saved', () => {
    expect(safeWindowBounds(undefined, [laptop], laptop)).toEqual({
      x: 360,
      y: 116,
      ...windowDefaultSize
    })
  })

  it('keeps saved bounds that are fully on a display', () => {
    const saved = { x: 100, y: 50, width: 1000, height: 700 }
    expect(safeWindowBounds(saved, [laptop], laptop)).toEqual(saved)
  })

  it('keeps a window on the second monitor while that monitor is connected', () => {
    const saved = { x: 2200, y: 100, width: 1400, height: 900 }
    expect(safeWindowBounds(saved, [laptop, rightMonitor], laptop)).toEqual(saved)
  })

  it('recenters on the primary display when the saved monitor is missing', () => {
    const saved = { x: 2200, y: 100, width: 1400, height: 900 }
    expect(safeWindowBounds(saved, [laptop], laptop)).toEqual({ x: 260, y: 66, width: 1400, height: 900 })
  })

  it('keeps a window that hangs partly off the edge but is still easy to grab', () => {
    const saved = { x: 1500, y: 200, width: 1000, height: 700 }
    expect(safeWindowBounds(saved, [laptop], laptop)).toEqual(saved)
  })

  it('recenters a window with only a sliver left on screen', () => {
    const saved = { x: 1850, y: 200, width: 1000, height: 700 }
    expect(safeWindowBounds(saved, [laptop], laptop)).toEqual({ x: 460, y: 166, width: 1000, height: 700 })
  })

  it('recenters a window whose title bar is above the top of the screen', () => {
    const saved = { x: 100, y: -300, width: 1000, height: 700 }
    expect(safeWindowBounds(saved, [laptop], laptop)).toEqual({ x: 460, y: 166, width: 1000, height: 700 })
  })

  it('shrinks and slides a window that no longer fits after scaling went up', () => {
    const saved = { x: 100, y: 50, width: 1600, height: 1000 }
    expect(safeWindowBounds(saved, [scaled150], scaled150)).toEqual({ x: 0, y: 0, width: 1280, height: 688 })
  })

  it('keeps the minimum size and the title bar on screen on a display smaller than the minimum', () => {
    const tiny: Rect = { x: 0, y: 0, width: 640, height: 480 }
    expect(safeWindowBounds(undefined, [tiny], tiny)).toEqual({ x: 0, y: 0, width: 800, height: 560 })
  })

  it('handles displays with negative coordinates (a monitor left of the primary)', () => {
    const leftMonitor: Rect = { x: -1920, y: 0, width: 1920, height: 1040 }
    const saved = { x: -1500, y: 100, width: 1000, height: 700 }
    expect(safeWindowBounds(saved, [leftMonitor, laptop], laptop)).toEqual(saved)
  })
})
