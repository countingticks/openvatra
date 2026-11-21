import { useState } from 'react'
import type { RunView } from '@app/features/runs'

interface Seen {
  /** The newest finished answer's seq. */
  answerSeq: number
  /** The failed notices already on screen, by key. */
  failed: Set<string>
}

function seenIn(view: RunView): Seen {
  let answerSeq = 0
  const failed = new Set<string>()
  for (const entry of view.entries) {
    if (entry.kind === 'answer' && !entry.partial) answerSeq = Math.max(answerSeq, entry.seq)
    if (entry.kind === 'notice' && entry.notice === 'failed') failed.add(entry.key)
  }
  return { answerSeq, failed }
}

/**
 * What the polite status region says: "Answer finished" once a new answer completes, or a new failure's sentence.
 * Nothing word by word, and nothing for what was already there when the chat opened (render it keyed by chat).
 */
export function useAnnouncer(view: RunView | null): string {
  const [seen, setSeen] = useState<Seen | null>(null)
  const [message, setMessage] = useState('')
  if (view === null) return message

  const now = seenIn(view)
  if (seen === null) {
    setSeen(now)
    return message
  }
  const failure = view.entries.find(
    (entry) => entry.kind === 'notice' && entry.notice === 'failed' && !seen.failed.has(entry.key)
  )
  const finished = now.answerSeq > seen.answerSeq
  if (failure !== undefined || finished) {
    setSeen(now)
    setMessage(
      failure?.kind === 'notice' && failure.notice === 'failed' ? failure.error.message : 'Answer finished'
    )
  }
  return message
}
