import { describe, expect, it } from 'vitest'
import type { ContextUse } from '@app/core/generated'
import { contextRows, withLive } from '@app/features/chat/contextRows'

const use = (used: number, size: number, parts: Partial<ContextUse['parts']> = {}): ContextUse => ({
  used,
  size,
  parts: { system: 0, messages: 0, messageCount: 0, search: 0, files: 0, ...parts }
})

const tokens = (context: ContextUse): Record<string, number> =>
  Object.fromEntries(contextRows(context).map((row) => [row.key, row.tokens]))

describe('contextRows', () => {
  it('splits the context into system prompt, messages and free space', () => {
    const rows = contextRows(use(3140, 32768, { system: 900, messageCount: 6 }))

    expect(rows).toEqual([
      { key: 'system', label: 'System prompt', tokens: 900 },
      { key: 'messages', label: 'Messages (6)', tokens: 2240 },
      { key: 'free', label: 'Free', tokens: 29628 }
    ])
  })

  it('adds web search and attached files, taking their tokens out of the messages', () => {
    const rows = contextRows(use(3140, 32768, { system: 900, messageCount: 6, search: 500, files: 200 }))

    expect(rows.map((row) => [row.key, row.tokens])).toEqual([
      ['system', 900],
      ['messages', 1540],
      ['search', 500],
      ['files', 200],
      ['free', 29628]
    ])
    expect(rows[2].label).toBe('Web search results')
    expect(rows[3].label).toBe('Attached files')
  })

  it('never goes below 0: used below the system prompt, used above the size', () => {
    expect(tokens(use(100, 32768, { system: 900 })).messages).toBe(0)
    expect(tokens(use(40000, 32768)).free).toBe(0)
  })
})

describe('withLive', () => {
  it('returns the context unchanged without a live answer', () => {
    const context = use(100, 1000)
    expect(withLive(context, undefined)).toBe(context)
  })

  it('adds the estimate of text and reasoning to used and to messages', () => {
    const live = { text: '1234567', reasoning: '1234567', n: 1, reasoningAt: null }
    expect(withLive(use(100, 1000, { messages: 60 }), live)).toEqual(use(104, 1000, { messages: 64 }))
  })
})
