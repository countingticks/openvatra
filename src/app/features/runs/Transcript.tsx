import { useState } from 'react'
import { Pencil } from 'lucide-react'
import { cn } from '@app/lib/utils'
import { Button } from '@app/ui/button'
import { AnswerActions } from './AnswerActions'
import { AnswerBlock } from './AnswerBlock'
import { thoughtLabel } from './answerText'
import { LastInputEditor } from './LastInputEditor'
import { LiveEntry } from './LiveEntry'
import { CopyButton } from '@app/ui/CopyButton'
import { MessageActions } from './MessageActions'
import type { RunView, TranscriptEntry } from './runView'

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
  /** Sends the last message again with this text; rejects when it could not be sent. */
  onEdit(text: string): Promise<void>
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
  onEdit
}: TranscriptProps): React.JSX.Element {
  const [editing, setEditing] = useState(false)
  // Only the last turn can be redone, and not while a run is at work.
  const last = view.entries.at(-1)
  const idle = view.activeRun === null
  const lastInput =
    idle && last
      ? view.entries.findLast((entry) => entry.kind === 'input' && entry.runId === last.runId)
      : undefined
  const render = (entry: TranscriptEntry): React.JSX.Element | null => {
    switch (entry.kind) {
      case 'input':
        if (editing && entry === lastInput) {
          return (
            <LastInputEditor
              text={entry.text}
              onSend={(text) => onEdit(text).then(() => setEditing(false))}
              onCancel={() => setEditing(false)}
            />
          )
        }
        return (
          <div className="group flex flex-col items-end gap-1">
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
              {entry === lastInput && !entry.queued && (
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Edit message"
                  onClick={() => setEditing(true)}
                >
                  <Pencil aria-hidden className="size-3.5" />
                </Button>
              )}
              <CopyButton text={entry.text} label="Copy message" />
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
