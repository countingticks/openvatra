import type { TranscriptEntry } from './runView'

/**
 * About two screens of text: what an open chat renders at first, and what each scroll up adds. Parsing an answer's
 * markdown is what makes opening a long chat slow, so the window is measured in text, not in entries.
 */
export const windowChars = 9000

const size = (entry: TranscriptEntry): number => {
  switch (entry.kind) {
    case 'input':
      return entry.text.length + entry.quotes.reduce((sum, quote) => sum + quote.text.length, 0)
    case 'answer':
      return entry.parts.reduce((sum, part) => sum + part.text.length, 0)
    default:
      return 0
  }
}

/**
 * Where the batch that ends just before `end` starts: the entries before `end` that together hold about
 * `windowChars` of text, cut where a turn starts (a run's first input), so a batch is always whole turns.
 */
export function batchStart(entries: TranscriptEntry[], end: number): number {
  let chars = 0
  for (let at = end - 1; at > 0; at--) {
    const entry = entries[at]
    chars += size(entry)
    const turnStart = entry.kind === 'input' && entries[at - 1].runId !== entry.runId
    if (turnStart && chars >= windowChars) return at
  }
  return 0
}
