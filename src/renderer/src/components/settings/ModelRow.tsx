import { useId, useState } from 'react'
import { ChevronDown } from 'lucide-react'
import { ModelOptionsForm } from '@renderer/components/settings/ModelOptionsForm'
import { Button } from '@renderer/components/ui/button'
import { describeModel, failureReason, formatSize, stateDot } from '@renderer/lib/modelText'
import { cn } from '@renderer/lib/utils'
import type { ModelInfo } from '../../../../shared/core'
import type { ModelOptions } from '../../../../shared/settings'

interface ModelRowProps {
  model: ModelInfo
  /** Shared by every row's embedding radio, so choosing one clears the others. */
  radioName: string
  embedding: boolean
  onEmbedding: () => void
  options: ModelOptions | undefined
  onOptions: (next: ModelOptions | undefined) => void
}

/** One model: name, size and state; Load or Unload; the embedding radio; its options, folded away by default. */
export function ModelRow({
  model,
  radioName,
  embedding,
  onEmbedding,
  options,
  onOptions
}: ModelRowProps): React.JSX.Element {
  /** The action in flight, kept from the click: the model's state changes while it runs. */
  const [pending, setPending] = useState<'load' | 'unload' | null>(null)
  const [failure, setFailure] = useState<string>()
  const [expanded, setExpanded] = useState(false)
  const ids = { radio: useId(), options: useId() }

  const running = model.state === 'loading' || model.state === 'ready'
  const action = running ? 'unload' : 'load'

  async function act(): Promise<void> {
    setPending(action)
    setFailure(undefined)
    try {
      await window.api.core[action](model.id)
    } catch (error) {
      setFailure(failureReason(error))
    } finally {
      setPending(null)
    }
  }

  // core's own error (state 'error') already says what went wrong; show a failed request only when it adds something.
  const problem = model.state === 'error' ? undefined : failure

  return (
    <li className="flex flex-col border-b border-border px-3 py-2.5 last:border-b-0">
      <div className="flex items-center gap-3">
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex items-center gap-1.5">
            <span aria-hidden className={cn('size-2 shrink-0 rounded-full', stateDot(model.state))} />
            <span className="truncate font-mono text-[13px]" title={model.id}>
              {model.id}
            </span>
          </span>
          <span
            className={cn('text-xs text-muted-foreground', model.state === 'error' && 'text-destructive')}
          >
            {formatSize(model.sizeBytes)} · {describeModel(model)}
          </span>
        </div>

        <div className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
          <input
            id={ids.radio}
            type="radio"
            name={radioName}
            checked={embedding}
            onChange={onEmbedding}
            aria-label={`Use ${model.id} for embeddings`}
            className="size-3.5 accent-primary"
          />
          <label htmlFor={ids.radio} aria-hidden>
            Embeddings
          </label>
        </div>

        <Button
          variant="outline"
          size="sm"
          disabled={pending !== null}
          aria-label={`${running ? 'Unload' : 'Load'} ${model.id}`}
          onClick={() => void act()}
          className="w-20"
        >
          {pending === 'load'
            ? 'Loading…'
            : pending === 'unload'
              ? 'Unloading…'
              : running
                ? 'Unload'
                : 'Load'}
        </Button>

        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={`Options for ${model.id}`}
          aria-expanded={expanded}
          aria-controls={ids.options}
          onClick={() => setExpanded((open) => !open)}
        >
          <ChevronDown aria-hidden className={cn('transition-transform', expanded && 'rotate-180')} />
        </Button>
      </div>

      {problem && (
        <p role="alert" className="pt-1.5 text-xs text-destructive">
          {problem}
        </p>
      )}
      {expanded && (
        <ModelOptionsForm
          id={ids.options}
          modelId={model.id}
          projector={model.projector}
          embedding={embedding}
          options={options}
          onChange={onOptions}
        />
      )}
    </li>
  )
}
