// Words for the Hugging Face search results and for a download's progress line.
import type { DownloadItem } from '@app/core/types'

const compact = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 })

/** 950 → "950", 1400 → "1.4K", 1_400_000 → "1.4M". */
export function compactCount(n: number): string {
  return compact.format(n)
}

const relative = new Intl.RelativeTimeFormat('en', { numeric: 'auto' })

const units: readonly [Intl.RelativeTimeFormatUnit, number][] = [
  ['year', 365 * 24 * 3600],
  ['month', 30 * 24 * 3600],
  ['week', 7 * 24 * 3600],
  ['day', 24 * 3600],
  ['hour', 3600],
  ['minute', 60]
]

/** "2 weeks ago", "yesterday", "3 months ago", from an ISO date and now; under a minute is "just now". */
export function updatedAgo(iso: string, now: number): string {
  const seconds = (Date.parse(iso) - now) / 1000
  for (const [unit, size] of units) {
    if (Math.abs(seconds) >= size) return relative.format(Math.trunc(seconds / size), unit)
  }
  return 'just now'
}

const gigabytes = (bytes: number): string => (bytes / 1024 ** 3).toFixed(1)

/** "4.2 of 14.3 GB · 38 MB/s"; the speed part is left out while speed is 0. */
export function speedProgress(item: DownloadItem): string {
  const sizes = `${gigabytes(item.bytes)} of ${gigabytes(item.total)} GB`
  if (item.speed <= 0) return sizes
  return `${sizes} · ${Math.max(1, Math.round(item.speed / 1024 ** 2))} MB/s`
}

/** Whole percent 0–100 of a download; 0 when total is 0. */
export function downloadPercent(item: DownloadItem): number {
  if (item.total <= 0) return 0
  return Math.min(100, Math.max(0, Math.round((item.bytes / item.total) * 100)))
}

/** "Results 11–20" for page 1 with 10 repos; "Results 1–3" for page 0 with 3 (en dash). count ≥ 1. */
export function resultRange(page: number, count: number): string {
  const first = page * 10 + 1
  return `Results ${first}–${first + count - 1}`
}

/** "1 quant", "12 quants". */
export function quantsLabel(n: number): string {
  return `${n} ${n === 1 ? 'quant' : 'quants'}`
}
