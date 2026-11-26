import { describe, expect, it } from 'vitest'
import { selectScenarios } from '../../perf/scenarios'

describe('selectScenarios', () => {
  it('selects all seven in spec order when no names are given', () => {
    expect(selectScenarios([]).map((s) => s.name)).toEqual([
      'idle',
      'stream',
      'stream-cpu',
      'stream-nogpu',
      'stream-still',
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
})
