import { RotateCw } from 'lucide-react'
import type { MessagePart, MessageStats } from '@app/core/generated'
import { Button } from '@app/ui/button'
import { answerCopyText, speedText, statsLine } from './answerText'
import { CopyButton, MessageActions } from './MessageActions'

/** Copy, Regenerate and the speed under a finished answer; shown on hover or focus, always in the accessibility tree. */
export function AnswerActions({
  parts,
  stats,
  onRegenerate
}: {
  parts: MessagePart[]
  stats: MessageStats | null
  onRegenerate?: () => void
}): React.JSX.Element {
  const speed = stats ? speedText(stats) : ''
  return (
    <MessageActions className="mt-1.5 -ml-1.5">
      <CopyButton text={answerCopyText(parts)} label="Copy answer" />
      {onRegenerate && (
        <Button variant="ghost" size="icon-sm" aria-label="Regenerate answer" onClick={onRegenerate}>
          <RotateCw aria-hidden className="size-3.5" />
        </Button>
      )}
      {stats && speed && (
        <span title={statsLine(stats)} className="ml-1 text-xs text-muted-foreground tabular-nums">
          {speed}
        </span>
      )}
    </MessageActions>
  )
}
