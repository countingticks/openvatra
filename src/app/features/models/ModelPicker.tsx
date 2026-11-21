import { useState } from 'react'
import { Check, LoaderCircle } from 'lucide-react'
import { Button } from '@app/ui/button'
import { useLoadModelMutation, useUnloadModelMutation } from '@app/core/generated'
import { useCudaEngine } from './useCudaEngine'
import { useEngineSettings } from './useEngineSettings'
import { failureReason } from './modelText'
import { cn } from '@app/lib/utils'
import type { ModelInfo } from '@app/core/types'

/** One model: the row chooses it for the chat; the small button beside it loads or unloads it. */
function PickerRow({
  model,
  selected,
  onPick,
  onUseStandardEngine
}: {
  model: ModelInfo
  selected: boolean
  onPick(id: string): Promise<void>
  /** Set while the faster (CUDA) engine is in use: a failed start may be its fault, so offer the way back. */
  onUseStandardEngine?: () => Promise<void>
}): React.JSX.Element {
  const [pending, setPending] = useState(false)
  const [failure, setFailure] = useState<string>()
  const [pickFailure, setPickFailure] = useState<string>()
  const [engineFailure, setEngineFailure] = useState<string>()
  const loaded = model.state === 'ready'
  const loading = model.state === 'loading' || pending
  const [load] = useLoadModelMutation()
  const [unload] = useUnloadModelMutation()

  async function act(): Promise<void> {
    setPending(true)
    setFailure(undefined)
    try {
      await (loaded ? unload : load)({ id: model.id }).unwrap()
    } catch (error) {
      setFailure(failureReason(error))
    } finally {
      setPending(false)
    }
  }

  async function pick(): Promise<void> {
    setPickFailure(undefined)
    try {
      await onPick(model.id)
    } catch (error) {
      setPickFailure(failureReason(error))
    }
  }

  // core's own error (state 'error') already says what went wrong; show a failed request only when it adds something.
  const problem = model.state === 'error' ? model.error : failure

  return (
    <li className="flex flex-col">
      <div className="flex items-start gap-1">
        <button
          type="button"
          aria-current={selected ? true : undefined}
          aria-label={`Use ${model.id}`}
          onClick={() => void pick()}
          className={cn(
            'flex min-w-0 flex-1 items-start gap-2 rounded-sm px-2 py-1.5 text-left outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring',
            selected && 'bg-accent/60'
          )}
        >
          <Check
            aria-hidden
            className={cn('mt-0.5 size-4 shrink-0 text-success', !selected && 'invisible')}
          />
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="truncate font-mono text-[13px]" title={model.id}>
              {model.id}
            </span>
            {loaded && <span className="text-xs text-muted-foreground">Loaded</span>}
          </span>
        </button>
        <Button
          variant="ghost"
          size="xs"
          disabled={loading}
          aria-label={`${loaded ? 'Unload' : 'Load'} ${model.id}`}
          onClick={() => void act()}
          className="mt-1 shrink-0 text-muted-foreground"
        >
          {loading && (
            <LoaderCircle aria-hidden className="animate-spin in-data-[motion=reduce]:animate-none" />
          )}
          {loaded ? 'Unload' : 'Load'}
        </Button>
      </div>
      {(problem || pickFailure) && (
        <div className="flex flex-col gap-0.5 px-2 pb-1 pl-8">
          {pickFailure && (
            <span role="alert" className="text-xs text-destructive">
              {pickFailure}
            </span>
          )}
          {problem && (
            <span role="alert" className="text-xs text-destructive">
              {problem}
            </span>
          )}
        </div>
      )}
      {problem && onUseStandardEngine && (
        <div className="px-2 pb-1 pl-8">
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setEngineFailure(undefined)
              onUseStandardEngine().catch((error: Error) => setEngineFailure(error.message))
            }}
          >
            Use the standard engine
          </Button>
          {engineFailure && (
            <p role="alert" className="pt-1 text-xs text-destructive">
              {engineFailure}
            </p>
          )}
        </div>
      )}
    </li>
  )
}

/** The chat models core found, shown in the model button's popover while core is ready. */
export function ModelPicker({
  models,
  selected,
  onPick
}: {
  models: ModelInfo[]
  selected: string | null
  onPick(id: string): Promise<void>
}): React.JSX.Element {
  const { inUse } = useCudaEngine()
  const { update } = useEngineSettings()
  const useStandard = inUse ? (): Promise<void> => update({ build: 'bundled' }) : undefined
  if (models.length === 0)
    return (
      <p className="text-xs text-muted-foreground">No models found. Choose a folder in Model settings.</p>
    )
  return (
    <ul aria-label="Models" className="flex max-h-60 flex-col gap-0.5 overflow-y-auto">
      {models.map((model) => (
        <PickerRow
          key={model.id}
          model={model}
          selected={model.id === selected}
          onPick={onPick}
          onUseStandardEngine={useStandard}
        />
      ))}
    </ul>
  )
}
