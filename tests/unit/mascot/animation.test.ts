import { describe, expect, it } from 'vitest'
import {
  barIndex,
  composeFrame,
  eyesOf,
  frameAt,
  mascotStates,
  nextBlinkTick,
  parseAnimation,
  playLength,
  toRuns,
  type Frame
} from '@renderer/mascot/animation'
import { loadAnimation } from '@renderer/mascot/loadAnimation'

// A tiny hand-made file: frames whose top-left pixel says which one they are.
function file(frames: Record<string, string>, extra: Record<string, unknown> = {}): unknown {
  const frame = (mark: string): string[] =>
    Array.from({ length: 16 }, (_, y) => (y === 0 ? mark + '.'.repeat(15) : '.'.repeat(16)))
  return {
    state: 'idle',
    ms: 100,
    pal: { A: '#111111', B: '#222222', C: '#333333', D: '#444444' },
    frames: Object.fromEntries(Object.entries(frames).map(([name, mark]) => [name, frame(mark)])),
    ...extra
  }
}
const mark = (frame: Frame): string => frame[0][0]

describe('parseAnimation', () => {
  it('plays numbered frames in name order, not the order JavaScript lists them', () => {
    // As an object, "10" is listed before "09"; the animation must still start at 09.
    const animation = parseAnimation(file({ '10': 'B', '09': 'A' }, { loop: true }))

    expect(animation.loop.map(mark)).toEqual(['A', 'B'])
    expect(animation.intro).toEqual([])
  })

  it('plays intro-* once, then loops loop-*', () => {
    const animation = parseAnimation(
      file({ 'loop-01': 'C', 'intro-02': 'B', 'intro-01': 'A', 'loop-02': 'D' }, { intro: 2, loop: 2 })
    )

    expect(animation.intro.map(mark)).toEqual(['A', 'B'])
    expect(animation.loop.map(mark)).toEqual(['C', 'D'])
  })

  it('treats loop: false as a one-shot that hands over to `then`', () => {
    const animation = parseAnimation(file({ '01': 'A', '02': 'B' }, { loop: false, then: 'idle' }))

    expect(animation.intro.map(mark)).toEqual(['A', 'B'])
    expect(animation.loop).toEqual([])
    expect(animation.then).toBe('idle')
  })

  it('rejects a frame that is not 16×16', () => {
    const broken = file({ '01': 'A' }) as { frames: Record<string, string[]> }
    broken.frames['01'] = broken.frames['01'].slice(1)

    expect(() => parseAnimation(broken)).toThrow()
  })

  it('rejects a file without frames it can play', () => {
    expect(() => parseAnimation(file({ 'bar-01': 'A' }))).toThrow(/no frames/)
  })
})

describe('frameAt', () => {
  const looping = parseAnimation(
    file({ 'intro-01': 'A', 'loop-01': 'B', 'loop-02': 'C' }, { intro: 1, loop: 2 })
  )
  const oneShot = parseAnimation(file({ '01': 'A', '02': 'B' }, { loop: false, then: 'idle' }))

  it('shows the intro first, then cycles the loop forever', () => {
    const marks = [0, 1, 2, 3, 4].map((tick) => mark(frameAt(looping, tick).frame))

    expect(marks).toEqual(['A', 'B', 'C', 'B', 'C'])
    expect(frameAt(looping, 1000).done).toBe(false)
  })

  it('holds the last frame of a one-shot and reports it as done', () => {
    expect(frameAt(oneShot, 1)).toMatchObject({ done: false })
    expect(frameAt(oneShot, 2)).toMatchObject({ done: true })
    expect(mark(frameAt(oneShot, 2).frame)).toBe('B')
  })

  it('knows how long a one-shot lasts', () => {
    expect(playLength(oneShot)).toBe(2)
    expect(playLength(looping)).toBe(Infinity)
  })
})

describe('toRuns', () => {
  it('merges neighbouring pixels of one colour and skips transparent ones', () => {
    const frame = ['AAB.' + '.'.repeat(12), ...Array.from({ length: 15 }, () => '.'.repeat(16))]

    expect(toRuns(frame, { A: '#111111', B: '#222222' })).toEqual([
      { x: 0, y: 0, width: 2, color: '#111111' },
      { x: 2, y: 0, width: 1, color: '#222222' }
    ])
  })
})

describe('the real frame files', () => {
  it.each(mascotStates)('%s.json is valid and has frames to play', (state) => {
    const animation = loadAnimation(state)

    expect(animation.state).toBe(state)
    expect(animation.intro.length + animation.loop.length).toBeGreaterThan(0)
  })

  it('match the brand notes: idle loops 72, error has a 10-frame intro, success hands over to idle', () => {
    expect(loadAnimation('idle')).toMatchObject({ intro: [], loop: { length: 72 } })
    expect(loadAnimation('error')).toMatchObject({ intro: { length: 10 }, loop: { length: 60 } })
    expect(loadAnimation('success')).toMatchObject({ intro: { length: 20 }, loop: [], then: 'idle' })
  })

  it('handles a one-shot idle file with no loop frames (no blink to find)', () => {
    expect(() => parseAnimation(file({ '01': 'A' }, { loop: false }))).not.toThrow()
  })
})

// Rows outside the eye box (9–12), so tests can check that only the eyes changed.
const outsideEyes = (frame: Frame): string[] => frame.filter((_, y) => y < 9 || y > 12)

describe('idle blink', () => {
  const idle = loadAnimation('idle')
  const bakedBlink = 52 // frames 53–55 in the file (ticks 52–54) are where the generator drew the blink

  it('lifts the three-step blink out of the loop', () => {
    expect(idle.blink?.steps).toHaveLength(3)
    expect(idle.blink?.open).toEqual(eyesOf(idle.loop[0]))
  })

  it('keeps the eyes open where the blink was baked in, and changes nothing else', () => {
    const frame = composeFrame(idle, bakedBlink)

    expect(eyesOf(frame)).toEqual(idle.blink?.open)
    expect(outsideEyes(frame)).toEqual(outsideEyes(idle.loop[bakedBlink]))
  })

  it('plays the blink wherever it is scheduled', () => {
    const frame = composeFrame(idle, 10, { blinkAt: 9 })

    expect(eyesOf(frame)).toEqual(idle.blink?.steps[1])
    expect(outsideEyes(frame)).toEqual(outsideEyes(idle.loop[10]))
  })

  it('reproduces the original frames when scheduled at the original moment', () => {
    for (const tick of [52, 53, 54]) {
      expect(composeFrame(idle, tick, { blinkAt: bakedBlink })).toEqual(idle.loop[tick])
    }
  })

  it('schedules the next blink 6–10 s later', () => {
    expect(nextBlinkTick(100, 100, () => 0)).toBe(160)
    expect(nextBlinkTick(100, 100, () => 0.5)).toBe(180)
    expect(nextBlinkTick(100, 100, () => 0.9999)).toBe(200)
  })
})

describe('loading progress', () => {
  const loading = loadAnimation('loading')

  it('lights 0…11 embers along the line, never past full', () => {
    expect([-1, 0, 0.09, 0.5, 0.99, 1, 2].map((p) => barIndex(p, 12))).toEqual([0, 0, 0, 5, 10, 11, 11])
  })

  it('draws the progress line over the live flame', () => {
    const frame = composeFrame(loading, 7, { progress: 0.5 })
    const row = loading.progress?.row ?? -1

    expect(row).toBe(15)
    expect(frame[row]).toBe(loading.progress?.bars[5][row])
    expect(frame.slice(0, row)).toEqual(loading.loop[7].slice(0, row))
  })

  it('runs the line like a fuse while progress is unknown', () => {
    expect(composeFrame(loading, 7)).toEqual(loading.loop[7])
  })

  it('has a ready burst that plays once and hands over to idle', () => {
    expect(loadAnimation('ready')).toMatchObject({ intro: { length: 4 }, loop: [], then: 'idle' })
  })
})
