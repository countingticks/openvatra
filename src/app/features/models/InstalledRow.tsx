import { useId, useState } from 'react'
import { ChevronDown } from 'lucide-react'
import { ModelOptionsForm } from './ModelOptionsForm'
import { Button } from '@app/ui/button'
import { failureReason, formatSize, shortContext, stateDot } from './modelText'
import { useUnloadModelMutation, type ModelOptions } from '@app/core/generated'
import { cn } from '@app/lib/utils'
import type { ModelInfo } from '@app/core/types'

export interface InstalledRowProps {
  model: ModelInfo
  options: ModelOptions | undefined
  /** Saves the model's options (undefined clears them); a rejected promise is shown in the panel. */
  onOptions: (next: ModelOptions | undefined) => Promise<void> | void
  expanded: boolean
  onToggle: () => void
}

const stateWords: Record<ModelInfo['state'], string> = {
  ready: 'loaded',
  loading: 'loading',
  error: 'failed',
  stopped: 'not loaded'
}

/** One model on one line, with its options folded under it. Running models is the model button's job. */
export function InstalledRow({
  model,
  options,
  onOptions,
  expanded,
  onToggle
}: InstalledRowProps): React.JSX.Element {
  const optionsId = useId()
  const [problem, setProblem] = useState<string>()
  const [unload, { isLoading: unloading }] = useUnloadModelMutation()
  const loaded = model.state === 'ready' || model.state === 'loading'

  function save(next: ModelOptions | undefined): void {
    setProblem(undefined)
    Promise.resolve(onOptions(next)).catch((error: unknown) => setProblem(failureReason(error)))
  }

  function unloadModel(): void {
    setProblem(undefined)
    unload({ id: model.id })
      .unwrap()
      .catch((error: unknown) => setProblem(failureReason(error)))
  }

  return (
    <li className="flex flex-col border-b border-border px-3 py-2.5 last:border-b-0">
      <div className="flex items-center gap-2.5">
        <span aria-hidden className={cn('size-2 shrink-0 rounded-full', stateDot(model.state))} />
        <span className="sr-only">{stateWords[model.state]}</span>
        <span className="min-w-0 truncate text-[13px]" title={model.id}>
          {model.name}
        </span>
        {model.tags.map((tag) => (
          <span key={tag} className="shrink-0 rounded-full bg-accent px-1.5 py-px text-[11px]">
            {tag}
          </span>
        ))}
        <span aria-hidden className="min-w-0 flex-1" />
        {model.context && (
          <span
            className="shrink-0 text-xs text-muted-foreground"
            title={`Loads with ${model.context.context.toLocaleString('en-US')} tokens of context`}
          >
            {shortContext(model.context.context)}
          </span>
        )}
        <span className="w-14 shrink-0 text-right text-xs text-muted-foreground">
          {formatSize(model.sizeBytes)}
        </span>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={`Options for ${model.name}`}
          aria-expanded={expanded}
          aria-controls={optionsId}
          onClick={onToggle}
        >
          <ChevronDown aria-hidden className={cn('transition-transform', expanded && 'rotate-180')} />
        </Button>
      </div>

      {/* Always mounted so it can animate shut: grid rows go 0fr <-> 1fr. While closed it is hidden from assistive
          technology and can't take focus (inert). */}
      <div
        aria-hidden={!expanded}
        inert={!expanded}
        className={cn(
          'grid transition-[grid-template-rows,opacity] duration-200 ease-out in-data-[motion=reduce]:transition-none',
          expanded ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0'
        )}
      >
        <div className="overflow-hidden">
          <ModelOptionsForm
            id={optionsId}
            model={model}
            options={options}
            expanded={expanded}
            onChange={save}
            footer={
              <>
                {problem && (
                  <p role="alert" className="text-xs text-destructive">
                    {problem}
                  </p>
                )}
                <div className="flex items-center justify-between gap-2">
                  <div className="flex gap-2" />
                  <div className="flex gap-2">
                    {loaded && (
                      <Button variant="ghost" size="sm" disabled={unloading} onClick={unloadModel}>
                        Unload
                      </Button>
                    )}
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={options === undefined}
                      onClick={() => save(undefined)}
                    >
                      Reset to defaults
                    </Button>
                  </div>
                </div>
              </>
            }
          />
        </div>
      </div>
    </li>
  )
}
