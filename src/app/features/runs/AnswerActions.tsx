import { RotateCw } from 'lucide-react'
import type { MessagePart, MessageStats } from '@app/core/generated'
import { Button } from '@app/ui/button'
import { answerCopyText, speedText, statsLine } from './answerText'
import { CopyButton } from '@app/ui/CopyButton'
import { MessageActions } from './MessageActions'
import { MessageTime } from './MessageTime'

/** Copy, Regenerate, the speed and the age under a finished answer. */
export function AnswerActions({
  parts,
  stats,
  time,
  onRegenerate
}: {
  parts: MessagePart[]
  stats: MessageStats | null
  time: number
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
        <span title={statsLine(stats)} className="mx-1 text-xs text-muted-foreground tabular-nums">
          {speed}
        </span>
      )}
      <MessageTime time={time} />
    </MessageActions>
  )
}
