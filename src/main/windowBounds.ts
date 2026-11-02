// Where to put the window at launch. Pure math with no Electron imports, so it's unit-testable with made-up
// monitor layouts. All values are in DIPs (device-independent pixels), the unit Electron's `screen` and
// `BrowserWindow` use, so Windows display scaling (125 %, 150 %…) is already accounted for.
import { windowMinSize } from '../shared/settings'

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export const windowDefaultSize = { width: 1200, height: 800 } as const

/**
 * How much of the window must sit on one display, with its top edge on that display, to count as reachable.
 * The top edge matters because the title bar is the handle the user drags the window back with.
 */
const minVisible = { width: 120, height: 80 } as const

/**
 * Turns the saved window bounds into bounds that are safe on the current displays.
 *
 * - Nothing saved: the default size, centered on the primary display.
 * - Saved and still reachable: kept; if it no longer fits the display it's on, shrunk and moved fully onto it.
 * - Saved but off-screen (monitor unplugged, layout changed): same size, centered on the primary display.
 *
 * `workAreas` are the displays' work areas (screen minus taskbar); `primary` is the primary display's work area.
 */
export function safeWindowBounds(saved: Rect | undefined, workAreas: Rect[], primary: Rect): Rect {
  if (!saved) return centerOn(primary, windowDefaultSize)

  const home = workAreas.find((area) => isReachable(saved, area))
  if (!home) return centerOn(primary, saved)

  const size = fitSize(saved, home)
  // A reachable window the user left hanging over an edge stays exactly where they put it.
  if (size.width === saved.width && size.height === saved.height) return saved

  // It had to shrink, so the user's layout is gone anyway; slide it fully onto the display.
  return {
    x: clamp(saved.x, home.x, home.x + home.width - size.width),
    y: clamp(saved.y, home.y, home.y + home.height - size.height),
    ...size
  }
}

function isReachable(window: Rect, area: Rect): boolean {
  const overlapWidth = Math.min(window.x + window.width, area.x + area.width) - Math.max(window.x, area.x)
  const overlapHeight = Math.min(window.y + window.height, area.y + area.height) - Math.max(window.y, area.y)
  const topEdgeOnArea = window.y >= area.y && window.y < area.y + area.height
  return topEdgeOnArea && overlapWidth >= minVisible.width && overlapHeight >= minVisible.height
}

function centerOn(area: Rect, size: { width: number; height: number }): Rect {
  const fitted = fitSize(size, area)
  // Clamped so that on a display smaller than the minimum size the title bar stays on screen.
  return {
    x: clamp(Math.round(area.x + (area.width - fitted.width) / 2), area.x, Infinity),
    y: clamp(Math.round(area.y + (area.height - fitted.height) / 2), area.y, Infinity),
    ...fitted
  }
}

/** No larger than the work area, no smaller than the window's minimum (which wins on a tiny display). */
function fitSize(size: { width: number; height: number }, area: Rect): { width: number; height: number } {
  return {
    width: Math.max(windowMinSize.width, Math.min(size.width, area.width)),
    height: Math.max(windowMinSize.height, Math.min(size.height, area.height))
  }
}

/** Like Math.min(Math.max(...)), but `low` wins if the range is empty (a window wider than its display). */
function clamp(value: number, low: number, high: number): number {
  return Math.max(low, Math.min(value, high))
}
