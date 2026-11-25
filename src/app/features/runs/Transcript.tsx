import { useState } from 'react'
import { Pencil } from 'lucide-react'
import { cn } from '@app/lib/utils'
import { Button } from '@app/ui/button'
import { AnswerActions } from './AnswerActions'
import { AnswerBlock } from './AnswerBlock'
import { thoughtLabel } from './answerText'
import { InputEditor } from './InputEditor'
import { LiveEntry } from './LiveEntry'
import { CopyButton } from '@app/ui/CopyButton'
import { MessageActions } from './MessageActions'
import { MessageTime } from './MessageTime'
import { RewindButton } from './RewindButton'
import { firstInputs, messagesAfter, type RunView, type TranscriptEntry } from './runView'

// Failures the model settings can fix (decision 20).
const settingsFixes = new Set(['model_not_found', 'model_load_failed', 'context_too_small'])

interface TranscriptProps {
  view: RunView
  /** The chat's model, for "Loading <model>…". */
  model: string
  modelLoading: boolean
  onContinue(runId: string): void
  onOpenModelSettings(): void
  /** Answers the last turn again (also what Retry does). */
  onRegenerate(): void
  /**
   * Sends this run's first message again with this text, removing that run and every later one; rejects when
   * it could not be sent.
   */
  onEdit(runId: string, text: string): Promise<void>
  /** Removes this run and every later one and puts its first message in the box; resolves when that is done or failed. */
  onRewind(runId: string): Promise<void>
}

const joined = (entry: Extract<TranscriptEntry, { kind: 'answer' }>, kind: 'text' | 'reasoning'): string =>
  entry.parts
    .filter((part) => part.kind === kind)
    .map((part) => part.text)
    .join('')

/** A chat's conversation: the user's bubbles, the answers, the live answer and the notices, in reading order. */
export function Transcript({
  view,
  model,
  modelLoading,
  onContinue,
  onOpenModelSettings,
  onRegenerate,
  onEdit,
  onRewind
}: TranscriptProps): React.JSX.Element {
  const [editing, setEditing] = useState<string | null>(null)
  // Only the last turn can be regenerated, and nothing is redone while a run is at work.
  const last = view.entries.at(-1)
  const idle = view.activeRun === null
  const starters = firstInputs(view.entries)
  const render = (entry: TranscriptEntry): React.JSX.Element | null => {
    switch (entry.kind) {
      case 'input':
        if (editing === entry.key) {
          return (
            <InputEditor
              text={entry.text}
              after={messagesAfter(view.entries, entry.key)}
              onSend={(text) => onEdit(entry.runId, text).then(() => setEditing(null))}
              onCancel={() => setEditing(null)}
            />
          )
        }
        return (
          <div className="flex flex-col items-end gap-1">
            <div
              className={cn(
                'max-w-[80%] rounded-2xl bg-bubble px-4 py-2.5 text-[15px] leading-[1.55] whitespace-pre-wrap',
                entry.queued && 'opacity-60'
              )}
            >
              {entry.text}
            </div>
            {entry.queued && <span className="text-xs text-muted-foreground">Queued</span>}
            <MessageActions>
              <CopyButton text={entry.text} label="Copy message" />
              {starters.has(entry.key) && (
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Edit message"
                  aria-disabled={!idle || undefined}
                  title={idle ? undefined : 'Stop the answer first'}
                  onClick={() => {
                    if (idle) setEditing(entry.key)
                  }}
                >
                  <Pencil aria-hidden className="size-3.5" />
                </Button>
              )}
              {starters.has(entry.key) && (
                <RewindButton blocked={!idle} onRewind={() => onRewind(entry.runId)} />
              )}
              <MessageTime time={entry.time} />
            </MessageActions>
          </div>
        )
      case 'answer':
        return (
          <AnswerBlock
            text={joined(entry, 'text')}
            reasoning={joined(entry, 'reasoning')}
            thinkingLabel={thoughtLabel(entry.stats?.reasoningMs)}
          >
            {entry.partial && !entry.failed && (
              <p className="mt-2 font-sans text-sm text-muted-foreground">Stopped</p>
            )}
            <AnswerActions
              parts={entry.parts}
              stats={entry.stats}
              time={entry.time}
              onRegenerate={idle && entry === last && !entry.failed ? onRegenerate : undefined}
            />
          </AnswerBlock>
        )
      case 'summary':
        return (
          <div className="flex items-center gap-3 text-xs text-muted-foreground">
            <span className="h-px flex-1 bg-border" />
            Earlier messages summarised
            <span className="h-px flex-1 bg-border" />
          </div>
        )
      case 'live':
        return (
          <LiveEntry
            runId={entry.runId}
            activeRun={view.activeRun}
            model={model}
            modelLoading={modelLoading}
          />
        )
      case 'notice':
        return entry.notice === 'interrupted' ? (
          <div className="flex items-center gap-3 text-sm text-muted-foreground">
            <span>Cut off when OpenVatra stopped</span>
            <Button variant="outline" size="sm" onClick={() => onContinue(entry.runId)}>
              Continue
            </Button>
          </div>
        ) : (
          <div className="flex items-center gap-3 text-sm text-muted-foreground">
            <span className="text-destructive">{entry.error.message}</span>
            {settingsFixes.has(entry.error.code) && (
              <Button variant="outline" size="sm" onClick={onOpenModelSettings}>
                Open model settings
              </Button>
            )}
            {idle && entry === last && (
              <Button variant="outline" size="sm" onClick={onRegenerate}>
                Retry
              </Button>
            )}
          </div>
        )
    }
  }

  return (
    <div className="mx-auto flex w-full max-w-[720px] flex-col gap-6">
      {view.entries.map((entry) => (
        <div key={entry.key}>{render(entry)}</div>
      ))}
    </div>
  )
}
