import { useState } from 'react'
import { Check, LoaderCircle } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { useLoadModelMutation, useUnloadModelMutation } from '@renderer/core/generated'
import { useCudaEngine } from '@renderer/hooks/useCudaEngine'
import { failureReason } from '@renderer/lib/modelText'
import { cn } from '@renderer/lib/utils'
import { useAppDispatch } from '@renderer/store/hooks'
import { settingsChanged } from '@renderer/store/settingsSlice'
import type { ModelInfo } from '../../../shared/core'

/** The whole row is the button: clicking a model loads it, clicking the loaded one unloads it. */
function PickerRow({
  model,
  onUseStandardEngine
}: {
  model: ModelInfo
  /** Set while the faster (CUDA) engine is in use: a failed start may be its fault, so offer the way back. */
  onUseStandardEngine?: () => void
}): React.JSX.Element {
  const [pending, setPending] = useState(false)
  const [failure, setFailure] = useState<string>()
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

  // core's own error (state 'error') already says what went wrong; show a failed request only when it adds something.
  const problem = model.state === 'error' ? model.error : failure

  return (
    <li>
      <button
        type="button"
        disabled={loading}
        aria-current={loaded ? true : undefined}
        aria-label={`${loading ? 'Loading' : loaded ? 'Unload' : 'Load'} ${model.id}`}
        onClick={() => void act()}
        className={cn(
          'flex w-full items-start gap-2 rounded-sm px-2 py-1.5 text-left outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default disabled:hover:bg-transparent',
          loaded && 'bg-success/10 hover:bg-success/15'
        )}
      >
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate font-mono text-[13px]" title={model.id}>
            {model.id}
          </span>
          {problem && (
            <span role="alert" className="text-xs text-destructive">
              {problem}
            </span>
          )}
        </span>
        {loading && (
          <LoaderCircle
            aria-hidden
            className="mt-0.5 size-4 shrink-0 animate-spin text-muted-foreground in-data-[motion=reduce]:animate-none"
          />
        )}
        {loaded && !loading && <Check aria-hidden className="mt-0.5 size-4 shrink-0 text-success" />}
      </button>
      {problem && onUseStandardEngine && (
        <div className="px-2 pb-1">
          <Button variant="outline" size="sm" onClick={onUseStandardEngine}>
            Use the standard engine
          </Button>
        </div>
      )}
    </li>
  )
}

/** The models core found, shown in the model button's popover while core is ready. */
export function ModelPicker({ models }: { models: ModelInfo[] }): React.JSX.Element {
  const { inUse } = useCudaEngine()
  const dispatch = useAppDispatch()
  const useStandard = inUse
    ? (): void => void dispatch(settingsChanged({ models: { engine: 'bundled' } }))
    : undefined
  if (models.length === 0)
    return (
      <p className="text-xs text-muted-foreground">No models found. Choose a folder in Model settings.</p>
    )
  return (
    <ul aria-label="Models" className="flex max-h-60 flex-col gap-0.5 overflow-y-auto">
      {models.map((model) => (
        <PickerRow key={model.id} model={model} onUseStandardEngine={useStandard} />
      ))}
    </ul>
  )
}
