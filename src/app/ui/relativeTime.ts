const SECOND = 1000
const MINUTE = 60 * SECOND
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

const ago = (n: number, unit: string): string => `${n} ${unit}${n === 1 ? '' : 's'} ago`

/** "just now", "1 minute ago", "3 hours ago", "2 days ago", "3 weeks ago", "4 months ago", "2 years ago". */
export function relativeTime(ms: number, now: number): string {
  // Clock skew can put a message slightly in the future; that reads as now.
  const d = Math.max(0, now - ms)
  if (d < MINUTE) return 'just now'
  if (d < HOUR) return ago(Math.floor(d / MINUTE), 'minute')
  if (d < DAY) return ago(Math.floor(d / HOUR), 'hour')
  const days = d / DAY
  if (days < 7) return ago(Math.floor(days), 'day')
  if (days < 35) return ago(Math.floor(days / 7), 'week')
  const months = Math.floor(days / 30.44)
  if (months < 12) return ago(months, 'month')
  return ago(Math.max(1, Math.floor(days / 365.25)), 'year')
}

/** The full local date and time, for the tooltip. */
export function fullTime(ms: number): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(ms)
}
