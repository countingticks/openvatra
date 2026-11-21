import { describe, expect, it } from 'vitest'
import { formatTokens } from '@app/features/chat/formatTokens'

describe('formatTokens', () => {
  it.each([
    [0, '0'],
    [1023, '1023'],
    [1024, '1k'],
    [3174, '3.1k'],
    [8192, '8k'],
    [32768, '32k'],
    [131072, '128k']
  ])('%i → %s', (n, shown) => {
    expect(formatTokens(n)).toBe(shown)
  })
})
