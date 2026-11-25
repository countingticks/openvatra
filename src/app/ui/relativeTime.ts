const SECOND = 1000
const MINUTE = 60 * SECOND
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/** "just now", "5 min ago", "3 h ago", "2 d ago", "3 w ago", "4 mo ago", "2 y ago". */
export function relativeTime(ms: number, now: number): string {
  // Clock skew can put a message slightly in the future; that reads as now.
  const d = Math.max(0, now - ms)
  if (d < MINUTE) return 'just now'
  if (d < HOUR) return `${Math.floor(d / MINUTE)} min ago`
  if (d < DAY) return `${Math.floor(d / HOUR)} h ago`
  const days = d / DAY
  if (days < 7) return `${Math.floor(days)} d ago`
  if (days < 35) return `${Math.floor(days / 7)} w ago`
  const months = Math.floor(days / 30.44)
  if (months < 12) return `${months} mo ago`
  return `${Math.max(1, Math.floor(days / 365.25))} y ago`
}

/** The full local date and time, for the tooltip. */
export function fullTime(ms: number): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(ms)
}
