import { describe, expect, it } from 'vitest'
import type { ChatItem } from '@app/core/generated'
import { groupChats, nextLocalMidnight } from '@app/features/chat/chatGroups'

const at = (y: number, m: number, d: number, h = 0, min = 0, s = 0): number =>
  new Date(y, m, d, h, min, s).getTime()

const chat = (id: string, updatedAt: number): ChatItem => ({
  id,
  title: id,
  titleSource: 'auto',
  model: 'tiny',
  updatedAt,
  activeRun: null
})

const now = at(2026, 10, 18, 15, 30)

const idsOf = (updatedAt: number): string | undefined => groupChats([chat('c', updatedAt)], now)[0]?.id

describe('groupChats', () => {
  it.each([
    ['00:00 today', at(2026, 10, 18), 'today'],
    ['23:59 yesterday', at(2026, 10, 17, 23, 59), 'week'],
    ['00:00 seven days ago', at(2026, 10, 11), 'week'],
    ['a minute before that', at(2026, 10, 10, 23, 59), 'older'],
    ['after now', now + 3_600_000, 'today']
  ])('puts a chat from %s in %s', (_name, updatedAt, group) => {
    expect(idsOf(updatedAt)).toBe(group)
  })

  it('leaves out empty groups and keeps the input order inside a group', () => {
    const groups = groupChats(
      [chat('a', at(2026, 10, 18, 9)), chat('b', 0), chat('c', at(2026, 10, 18, 8)), chat('d', 1)],
      now
    )
    expect(groups.map((g) => [g.id, g.label, g.chats.map((c) => c.id)])).toEqual([
      ['today', 'Today', ['a', 'c']],
      ['older', 'Older', ['b', 'd']]
    ])
  })
})

describe('nextLocalMidnight', () => {
  it('is a second later at 23:59:59', () => {
    const t = at(2026, 10, 18, 23, 59, 59)
    expect(nextLocalMidnight(t)).toBe(t + 1000)
  })

  it('is a day later at 00:00:00', () => {
    expect(nextLocalMidnight(at(2026, 10, 18))).toBe(at(2026, 10, 19))
  })
})
