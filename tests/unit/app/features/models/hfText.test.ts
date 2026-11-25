import { describe, expect, it } from 'vitest'
import type { DownloadItem } from '@app/core/types'
import {
  compactCount,
  downloadPercent,
  resultRange,
  speedProgress,
  updatedAgo
} from '@app/features/models/hfText'

const item = (overrides: Partial<DownloadItem> = {}): DownloadItem => ({
  id: 'a',
  name: 'a',
  state: 'downloading',
  bytes: 0,
  total: 0,
  speed: 0,
  ...overrides
})

describe('compactCount', () => {
  it.each([
    [950, '950'],
    [1400, '1.4K'],
    [1_400_000, '1.4M']
  ])('%d reads %s', (n, text) => {
    expect(compactCount(n)).toBe(text)
  })
})

describe('updatedAgo', () => {
  const now = Date.parse('2026-11-24T12:00:00Z')
  const before = (seconds: number): string => new Date(now - seconds * 1000).toISOString()
  it.each([
    ['14 days', 14 * 86400, '2 weeks ago'],
    ['1 day', 86400, 'yesterday'],
    ['95 days', 95 * 86400, '3 months ago'],
    ['30 seconds', 30, 'just now']
  ])('%s ago reads %s', (_name, seconds, text) => {
    expect(updatedAgo(before(seconds), now)).toBe(text)
  })
})

describe('speedProgress', () => {
  const gb = 1024 ** 3
  it('shows sizes and speed', () => {
    expect(speedProgress(item({ bytes: 4.2 * gb, total: 14.3 * gb, speed: 38 * 1024 ** 2 }))).toBe(
      '4.2 of 14.3 GB · 38 MB/s'
    )
  })
  it('leaves the speed out while it is 0', () => {
    expect(speedProgress(item({ bytes: 4.2 * gb, total: 14.3 * gb }))).toBe('4.2 of 14.3 GB')
  })
  it('shows 0.4 MB/s as 1 MB/s', () => {
    expect(speedProgress(item({ bytes: gb, total: 2 * gb, speed: 0.4 * 1024 ** 2 }))).toBe(
      '1.0 of 2.0 GB · 1 MB/s'
    )
  })
})

describe('downloadPercent', () => {
  it('is 0 when the total is 0', () => {
    expect(downloadPercent(item({ bytes: 5, total: 0 }))).toBe(0)
  })
  it('is a whole percent', () => {
    expect(downloadPercent(item({ bytes: 38, total: 100 }))).toBe(38)
  })
})

describe('resultRange', () => {
  it.each([
    [0, 10, 'Results 1–10'],
    [1, 10, 'Results 11–20'],
    [1, 4, 'Results 11–14'],
    [0, 1, 'Results 1–1']
  ])('page %i with %i repos reads %s', (page, count, text) => {
    expect(resultRange(page, count)).toBe(text)
  })
})
