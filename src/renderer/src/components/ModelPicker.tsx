import { useState } from 'react'
import { Button } from '@renderer/components/ui/button'
import { describeModel, failureReason } from '@renderer/lib/modelText'
import { cn } from '@renderer/lib/utils'
import type { ModelInfo } from '../../../shared/core'

function PickerRow({ model }: { model: ModelInfo }): React.JSX.Element {
  const [pending, setPending] = useState(false)
  const [failure, setFailure] = useState<string>()
  const running = model.state === 'loading' || model.state === 'ready'
  const action = running ? 'unload' : 'load'

  async function act(): Promise<void> {
    setPending(true)
    setFailure(undefined)
    try {
      await window.api.core[action](model.id)
    } catch (error) {
      setFailure(failureReason(error))
    } finally {
      setPending(false)
    }
  }

  // core's own error (state 'error') already says what went wrong; show a failed request only when it adds something.
  const problem = model.state === 'error' ? undefined : failure

  return (
    <li className="flex flex-col gap-1">
      <div className="flex items-center gap-2">
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="truncate font-mono text-[13px]" title={model.id}>
            {model.id}
          </span>
          <span
            className={cn('text-xs text-muted-foreground', model.state === 'error' && 'text-destructive')}
          >
            {describeModel(model)}
          </span>
        </div>
        <Button
          variant="outline"
          size="sm"
          disabled={pending}
          aria-label={`${running ? 'Unload' : 'Load'} ${model.id}`}
          onClick={() => void act()}
          className="w-20"
        >
          {pending ? (running ? 'Unloading…' : 'Loading…') : running ? 'Unload' : 'Load'}
        </Button>
      </div>
      {problem && (
        <p role="alert" className="text-xs text-destructive">
          {problem}
        </p>
      )}
    </li>
  )
}

/** The models core found, each with Load or Unload; shown in the model button's popover while core is ready. */
export function ModelPicker({ models }: { models: ModelInfo[] }): React.JSX.Element {
  if (models.length === 0)
    return (
      <p className="text-xs text-muted-foreground">No models found. Choose a folder in Model settings.</p>
    )
  return (
    <ul aria-label="Models" className="flex max-h-60 flex-col gap-2 overflow-y-auto">
      {models.map((model) => (
        <PickerRow key={model.id} model={model} />
      ))}
    </ul>
  )
}
