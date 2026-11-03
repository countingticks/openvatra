import { describe, expect, it } from 'vitest'
import { applyMotion, shouldReduceMotion } from '@renderer/motion'

describe('shouldReduceMotion', () => {
  it.each([
    ['system', false, false],
    ['system', true, true],
    ['on', false, false],
    ['on', true, false],
    ['off', false, true],
    ['off', true, true]
  ] as const)(
    'Animations "%s" with Windows asking for less motion: %s → hold still: %s',
    (setting, windows, reduce) => {
      expect(shouldReduceMotion(setting, windows)).toBe(reduce)
    }
  )
})

describe('applyMotion', () => {
  it('writes the decision onto <html> for CSS and components to read', () => {
    applyMotion(true)
    expect(document.documentElement).toHaveAttribute('data-motion', 'reduce')

    applyMotion(false)
    expect(document.documentElement).toHaveAttribute('data-motion', 'full')
  })
})
