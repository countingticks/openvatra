import { useEffect, useState } from 'react'
import type { MessagePart, MessageStats } from '@app/core/generated'
import { Button } from '@app/ui/button'
import { answerCopyText, statsLine } from './answerText'

/** Copy and the stats line under a finished answer; shown on hover or focus, always in the accessibility tree. */
export function AnswerActions({
  parts,
  stats
}: {
  parts: MessagePart[]
  stats: MessageStats | null
}): React.JSX.Element {
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 1500)
    return () => clearTimeout(timer)
  }, [copied])

  const copy = (): void => {
    navigator.clipboard
      .writeText(answerCopyText(parts))
      .then(() => setCopied(true))
      .catch((error: unknown) => console.error('Could not copy the answer', error))
  }

  return (
    <div className="mt-2 flex items-center gap-3 font-sans opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100">
      <Button variant="ghost" size="xs" aria-label="Copy answer" onClick={copy}>
        {copied ? 'Copied' : 'Copy'}
      </Button>
      {stats && <span className="text-xs text-muted-foreground tabular-nums">{statsLine(stats)}</span>}
    </div>
  )
}
