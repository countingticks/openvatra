// The pixel backdrop's pattern (design decision, T21): diagonal streaks fading out by 32% of the height, clouds
// rising from 55% down, the middle left clear. A slowly drifting field of waves is ordered-dithered into four
// tones. Pure: it fills a pixel buffer, so it's tested without a canvas.

/** Screen pixels per backdrop pixel. */
export const backdropPixelSize = 4

/** How fast the pattern drifts: field time units per second (about a minute per cycle). */
export const driftPerSecond = 0.18

export type Rgb = readonly [number, number, number]

// 4×4 ordered-dither (Bayer) thresholds: neighbouring pixels get spread-out thresholds, so a smooth value turns
// into an even stipple of the tones instead of hard bands.
const bayer = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5]

const streaksEnd = 0.32
const cloudsStart = 0.55

/** How strongly row `y` of `height` shows the streaks (top) and the clouds (bottom); 0 in the clear middle. */
function bands(y: number, height: number): { top: number; bottom: number } {
  const fy = y / height
  const top = Math.max(0, 1 - fy / streaksEnd)
  const bottom = Math.max(0, (fy - cloudsStart) / (1 - cloudsStart))
  // Squared, so each band fades in softly instead of starting at a hard line.
  return { top: top * top, bottom: bottom * bottom }
}

/**
 * Fills `out` (RGBA, `width`×`height`) with the pattern at time `t`. `tones` are the four steps from faint to
 * strong; pixels below the first step are transparent so the background shows through.
 */
export function drawBackdrop(
  out: Uint8ClampedArray,
  width: number,
  height: number,
  t: number,
  tones: readonly Rgb[],
  strength = 1
): void {
  for (let y = 0; y < height; y++) {
    const { top, bottom } = bands(y, height)
    for (let x = 0; x < width; x++) {
      let value = 0
      if (bottom > 0) {
        const cloud =
          0.5 +
          0.5 *
            Math.sin(x * 0.045 + t * 6 + Math.sin(y * 0.07 + t * 4) * 1.6) *
            Math.cos(y * 0.05 - t * 3 + Math.sin(x * 0.03) * 2)
        value += bottom * (0.5 + 0.75 * cloud)
      }
      if (top > 0) {
        const streak =
          0.5 + 0.5 * Math.sin((x * 0.35 - y * 0.9) * 0.12 + t * 8 + Math.sin(x * 0.02 + t * 2) * 2)
        value += top * (0.35 + 0.8 * streak * streak)
      }

      const level = Math.floor(value * strength * tones.length + bayer[(y & 3) * 4 + (x & 3)] / 16)
      const i = (y * width + x) * 4
      if (level <= 0) {
        out[i + 3] = 0
        continue
      }
      const [r, g, b] = tones[Math.min(level, tones.length) - 1]
      out[i] = r
      out[i + 1] = g
      out[i + 2] = b
      out[i + 3] = 255
    }
  }
}
