/** A token count as the meter shows it: 900, 3.1k, 8k, 32k (k = 1024, the unit context sizes come in). */
export function formatTokens(n: number): string {
  if (n < 1024) return String(n)
  const k = n / 1024
  if (k >= 10) return `${Math.round(k)}k`
  return `${(Math.round(k * 10) / 10).toFixed(1).replace(/\.0$/, '')}k`
}
