import { describe, expect, it } from 'vitest'
import { longReply, scenarios, selectScenarios } from '../../perf/scenarios'

describe('selectScenarios', () => {
  it('selects all eight in spec order when no names are given', () => {
    expect(selectScenarios([]).map((s) => s.name)).toEqual([
      'idle',
      'stream',
      'stream-cpu',
      'stream-nogpu',
      'stream-still',
      'stream-long',
      'real',
      'real-nogpu'
    ])
  })

  it('selects the named scenarios in list order, not argument order', () => {
    expect(selectScenarios(['stream-still', 'idle']).map((s) => s.name)).toEqual(['idle', 'stream-still'])
  })

  it('throws with the list of names for an unknown name', () => {
    expect(() => selectScenarios(['nope'])).toThrow(/unknown scenario "nope"; one of: idle, stream/)
  })

  it('longReply repeats the text 20 times with a blank line between', () => {
    const out = longReply('a\n')
    expect(out).toBe(Array<string>(20).fill('a\n').join('\n\n'))
    expect(out.startsWith('a\n')).toBe(true)
    expect(out.split('\n\n')).toHaveLength(20)
  })

  it('every scenario except stream-long warms up 2 s and streams the answer fixture', () => {
    for (const s of scenarios.filter((x) => x.name !== 'stream-long')) {
      expect([s.name, s.warmupS, s.reply]).toEqual([s.name, 2, 'answer'])
    }
  })
})
