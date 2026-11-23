import { describe, expect, it } from 'vitest'
import type { MessageStats } from '@app/core/generated'
import { answerCopyText, speedText, statsLine, thoughtLabel } from '@app/features/runs/answerText'

const stats: MessageStats = {
  promptTokens: 412,
  answerTokens: 286,
  exact: true,
  tokensPerSecond: 0,
  firstTokenMs: 0,
  durationMs: 7500,
  contextSize: 8192,
  reasoningMs: 0
}

describe('answerText', () => {
  it('leaves the speed out of the stats line when there is none', () => {
    expect(statsLine(stats)).toBe('412 in · 286 out · 7.5 s')
  })

  it.each([
    [37.6, '38 tok/s'],
    [0.2, '']
  ])('speedText(%s) is "%s"', (tokensPerSecond, text) => {
    expect(speedText({ ...stats, tokensPerSecond })).toBe(text)
  })

  it.each([
    [undefined, 'Thoughts'],
    [400, 'Thought for 1 s'],
    [12_000, 'Thought for 12 s']
  ])('thoughtLabel(%s) is %s', (ms, label) => {
    expect(thoughtLabel(ms)).toBe(label)
  })

  it('copies the text parts without the reasoning', () => {
    expect(
      answerCopyText([
        { kind: 'reasoning', text: 'hmm' },
        { kind: 'text', text: 'Hi' }
      ])
    ).toBe('Hi')
  })
})
