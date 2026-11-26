import { useState } from 'react'
import type { RunSnapshot } from '@app/core/generated'
import { useAppSelector } from '@app/store/hooks'
import { AnswerBlock } from './AnswerBlock'
import { thoughtLabel } from './answerText'
import { selectSched } from './liveSlice'
import { waitingLine } from './runView'
import { useLiveAnswer } from './useLiveAnswer'

/** The answer a run is writing now; before any of it arrives, why it has not started (when there is a reason). */
export function LiveEntry({
  runId,
  activeRun,
  model,
  modelLoading
}: {
  runId: string
  activeRun: RunSnapshot | null
  model: string
  modelLoading: boolean
}): React.JSX.Element | null {
  const live = useLiveAnswer(runId)
  const sched = useAppSelector(selectSched)
  // Fixed at the first frame with text, so the label stops counting once the model starts answering.
  const [thoughtMs, setThoughtMs] = useState<number | null>(null)
  if (thoughtMs === null && live !== undefined && live.text !== '' && live.reasoningAt !== null) {
    const { reasoningAt } = live
    setThoughtMs(() => Date.now() - reasoningAt)
  }

  if (live === undefined || (live.text === '' && live.reasoning === '')) {
    const line = waitingLine({ activeRun, live, sched, model, modelLoading })
    return line === null ? null : <p className="text-sm text-muted-foreground">{line}</p>
  }
  return (
    <AnswerBlock
      text={live.text}
      live
      reasoning={live.reasoning}
      thinkingLabel={live.text === '' ? 'Thinking…' : thoughtLabel(Math.max(1, thoughtMs ?? 0))}
    />
  )
}
