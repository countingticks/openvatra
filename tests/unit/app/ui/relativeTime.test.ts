import { describe, expect, it } from 'vitest'
import { fullTime, relativeTime } from '@app/ui/relativeTime'

const S = 1000
const MIN = 60 * S
const H = 60 * MIN
const D = 24 * H
const now = 1_800_000_000_000

describe('relativeTime', () => {
  it.each([
    ['0 s', 0, 'just now'],
    ['59 s', 59 * S, 'just now'],
    ['60 s', 60 * S, '1 minute ago'],
    ['59 min', 59 * MIN, '59 minutes ago'],
    ['60 min', 60 * MIN, '1 hour ago'],
    ['23 h 59 min', 23 * H + 59 * MIN, '23 hours ago'],
    ['24 h', 24 * H, '1 day ago'],
    ['6 d', 6 * D, '6 days ago'],
    ['7 d', 7 * D, '1 week ago'],
    ['34 d', 34 * D, '4 weeks ago'],
    ['35 d', 35 * D, '1 month ago'],
    ['365 d', 365 * D, '11 months ago'],
    ['366 d', 366 * D, '1 year ago'],
    ['800 d', 800 * D, '2 years ago'],
    ['5 s in the future', -5 * S, 'just now']
  ])('%s old reads %s', (_label, age, expected) => {
    expect(relativeTime(now - age, now)).toBe(expected)
  })

  it('fullTime is the medium date with a short time', () => {
    const expected = new Intl.DateTimeFormat(undefined, {
      dateStyle: 'medium',
      timeStyle: 'short'
    }).format(now)
    expect(fullTime(now)).toBe(expected)
  })
})
