// The words under and above an answer: its stats line, its thinking label, and what Copy takes.
import type { MessagePart, MessageStats } from '@app/core/generated'

/** "38 tok/s · 412 in · 286 out · 7.5 s"; estimated counts get a "~", and no speed is left out. */
export function statsLine(stats: MessageStats): string {
  const count = (n: number): string => `${stats.exact ? '' : '~'}${n}`
  const speed = Math.round(stats.tokensPerSecond)
  return [
    ...(speed > 0 ? [`${speed} tok/s`] : []),
    `${count(stats.promptTokens)} in`,
    `${count(stats.answerTokens)} out`,
    `${(stats.durationMs / 1000).toFixed(1)} s`
  ].join(' · ')
}

/** The thinking disclosure's label once the answer is done. */
export function thoughtLabel(reasoningMs: number | undefined): string {
  if (!reasoningMs) return 'Thoughts'
  return `Thought for ${Math.max(1, Math.round(reasoningMs / 1000))} s`
}

/** What Copy puts on the clipboard: the answer's text, never its reasoning. */
export function answerCopyText(parts: MessagePart[]): string {
  return parts
    .filter((part) => part.kind === 'text')
    .map((part) => part.text)
    .join('')
}
