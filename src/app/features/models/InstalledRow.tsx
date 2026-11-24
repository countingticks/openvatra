import { useEffect, useId, useRef, useState } from 'react'
import { ChevronDown } from 'lucide-react'
import { ModelOptionsForm } from './ModelOptionsForm'
import { Button } from '@app/ui/button'
import { failureReason, formatSize, shortContext, stateDot } from './modelText'
import { useRemoveModelMutation, useUnloadModelMutation, type ModelOptions } from '@app/core/generated'
import { cn } from '@app/lib/utils'
import type { ModelInfo } from '@app/core/types'

export interface InstalledRowProps {
  model: ModelInfo
  options: ModelOptions | undefined
  /** Saves the model's options (undefined clears them); a rejected promise is shown in the panel. */
  onOptions: (next: ModelOptions | undefined) => Promise<void> | void
  expanded: boolean
  onToggle: () => void
  /** Scroll the row into view once it is open: the dialog was opened for this model. */
  reveal?: boolean
}

const stateWords: Record<ModelInfo['state'], string> = {
  ready: 'loaded',
  loading: 'loading',
  error: 'failed',
  stopped: 'not loaded'
}

/**
 * Removing a model: the question, and the request after it. The question says what it frees and that the Recycle
 * Bin can give it back; a refusal (a run is answering with it) is shown under the row.
 */
function useRemove(model: ModelInfo): {
  asking: boolean
  ask: () => void
  keep: () => void
  remove: () => void
  removing: boolean
  problem: string | undefined
} {
  const [asking, setAsking] = useState(false)
  const [problem, setProblem] = useState<string>()
  const [removeModel, { isLoading: removing }] = useRemoveModelMutation()

  return {
    asking,
    ask: () => {
      setProblem(undefined)
      setAsking(true)
    },
    keep: () => setAsking(false),
    remove: () => {
      removeModel({ id: model.id })
        .unwrap()
        .catch((error: unknown) => setProblem(failureReason(error)))
        .finally(() => setAsking(false))
    },
    removing,
    problem
  }
}

function RemoveConfirm({
  model,
  removing,
  onRemove,
  onKeep
}: {
  model: ModelInfo
  removing: boolean
  onRemove: () => void
  onKeep: () => void
}): React.JSX.Element {
  return (
    <div role="alert" className="flex flex-col gap-2 rounded-md bg-muted/50 p-3 text-sm">
      <p>
        Remove {model.name}? This frees about {formatSize(model.sizeBytes)}. It goes to the Recycle Bin.
      </p>
      <div className="flex gap-2">
        <Button variant="destructive" size="sm" disabled={removing} onClick={onRemove}>
          Remove it
        </Button>
        <Button variant="outline" size="sm" disabled={removing} onClick={onKeep}>
          Keep it
        </Button>
      </div>
    </div>
  )
}

/** A file in the models folder that could not be read: its reason, and the way to get rid of it. */
export function UnreadableRow({ model }: { model: ModelInfo }): React.JSX.Element {
  const remove = useRemove(model)
  const removeButton = useRef<HTMLButtonElement>(null)

  return (
    <li className="flex flex-col gap-1.5 border-b border-border px-3 py-2.5 last:border-b-0">
      <div className="flex items-center gap-2.5">
        <span className="min-w-0 flex-1 truncate font-mono text-[13px]" title={model.id}>
          {model.id}
        </span>
        <span className="w-14 shrink-0 text-right text-xs text-muted-foreground">
          {formatSize(model.sizeBytes)}
        </span>
        <Button
          ref={removeButton}
          variant="ghost"
          size="sm"
          className="text-destructive"
          onClick={remove.ask}
        >
          Remove…
        </Button>
      </div>
      <p className="text-xs text-destructive">{model.error ?? 'The file could not be read.'}</p>
      {remove.asking && (
        <RemoveConfirm
          model={model}
          removing={remove.removing}
          onRemove={remove.remove}
          onKeep={() => {
            remove.keep()
            removeButton.current?.focus()
          }}
        />
      )}
      {remove.problem && (
        <p role="alert" className="text-xs text-destructive">
          {remove.problem}
        </p>
      )}
    </li>
  )
}

/** One model on one line, with its options folded under it. Running models is the model button's job. */
export function InstalledRow({
  model,
  options,
  onOptions,
  expanded,
  onToggle,
  reveal = false
}: InstalledRowProps): React.JSX.Element {
  const optionsId = useId()
  const [problem, setProblem] = useState<string>()
  const [unload, { isLoading: unloading }] = useUnloadModelMutation()
  const remove = useRemove(model)
  const removeButton = useRef<HTMLButtonElement>(null)
  const row = useRef<HTMLLIElement>(null)
  const loaded = model.state === 'ready' || model.state === 'loading'

  useEffect(() => {
    // Optional call: jsdom, which the unit tests run in, has no scrollIntoView.
    if (reveal && expanded) row.current?.scrollIntoView?.({ block: 'nearest' })
  }, [reveal, expanded])

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
    <li ref={row} className="flex flex-col border-b border-border px-3 py-2.5 last:border-b-0">
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
                  <Button
                    ref={removeButton}
                    variant="ghost"
                    size="sm"
                    className="text-destructive"
                    onClick={remove.ask}
                  >
                    Remove model…
                  </Button>
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
                {remove.asking && (
                  <RemoveConfirm
                    model={model}
                    removing={remove.removing}
                    onRemove={remove.remove}
                    onKeep={() => {
                      remove.keep()
                      removeButton.current?.focus()
                    }}
                  />
                )}
              </>
            }
          />
        </div>
      </div>
      {remove.problem && (
        <p role="alert" className="pt-2 text-xs text-destructive">
          {remove.problem}
        </p>
      )}
    </li>
  )
}
