// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { drawBackdrop, type Rgb } from '@renderer/backdrop/pattern'

const tones: Rgb[] = [
  [10, 10, 10],
  [20, 20, 20],
  [30, 30, 30],
  [40, 40, 40]
]
const width = 120
const height = 100

function draw(t: number, strength = 1): Uint8ClampedArray {
  const out = new Uint8ClampedArray(width * height * 4)
  drawBackdrop(out, width, height, t, tones, strength)
  return out
}

/** How many pixels are painted in rows [from, to). */
function painted(out: Uint8ClampedArray, from: number, to: number): number {
  let count = 0
  for (let i = from * width * 4 + 3; i < to * width * 4; i += 4) if (out[i] === 255) count++
  return count
}

describe('drawBackdrop', () => {
  it('paints streaks at the top and clouds at the bottom', () => {
    const out = draw(1.3)

    expect(painted(out, 0, 10)).toBeGreaterThan(0)
    expect(painted(out, 90, 100)).toBeGreaterThan(0)
  })

  it('always leaves the middle clear (32%–55% of the height), where messages are read', () => {
    for (const t of [0, 0.7, 3.1, 42]) {
      expect(painted(draw(t), 32, 56)).toBe(0)
    }
  })

  it('uses only the four tones, fully opaque, or leaves the pixel transparent', () => {
    const out = draw(2.2)
    const allowed = new Set(tones.map((tone) => tone.join()))

    for (let i = 0; i < out.length; i += 4) {
      if (out[i + 3] === 0) continue
      expect(out[i + 3]).toBe(255)
      expect(allowed.has(`${out[i]},${out[i + 1]},${out[i + 2]}`)).toBe(true)
    }
  })

  it('draws nothing at strength 0', () => {
    expect(painted(draw(1, 0), 0, height)).toBe(0)
  })

  it('drifts: the pattern changes over time, a little at a time', () => {
    const changedPixels = (a: Uint8ClampedArray, b: Uint8ClampedArray): number => {
      let count = 0
      for (let i = 3; i < a.length; i += 4) if (a[i] !== b[i]) count++
      return count
    }
    const now = draw(5)

    // One frame later (~80 ms of drift) only a few pixels change; much later, many do.
    const nextFrame = changedPixels(now, draw(5 + 0.08 * 0.18))
    const muchLater = changedPixels(now, draw(5 + 10))
    expect(nextFrame).toBeGreaterThan(0)
    expect(nextFrame).toBeLessThan(muchLater / 4)
  })

  it('is the same for the same moment (no hidden randomness)', () => {
    expect(draw(7.5)).toEqual(draw(7.5))
  })
})
