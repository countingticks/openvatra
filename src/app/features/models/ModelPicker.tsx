import { useId, useState } from 'react'
import { Button } from '@app/ui/button'
import { failureReason, modelDetail, stateDot } from './modelText'
import { cn } from '@app/lib/utils'
import type { ModelInfo } from '@app/core/types'

/** One model as an option: the dot, its name, and a second line with its details, or what went wrong. */
function PickerOption({
  model,
  selected,
  onPick
}: {
  model: ModelInfo
  selected: boolean
  onPick(id: string): Promise<void>
}): React.JSX.Element {
  const id = useId()
  const [pickFailure, setPickFailure] = useState<string>()

  async function pick(): Promise<void> {
    setPickFailure(undefined)
    try {
      await onPick(model.id)
    } catch (error) {
      setPickFailure(failureReason(error))
    }
  }

  const problem = pickFailure ?? (model.state === 'error' ? model.error : undefined)

  return (
    <button
      type="button"
      role="option"
      aria-selected={selected}
      aria-labelledby={`${id}-name`}
      aria-describedby={`${id}-detail`}
      onClick={() => void pick()}
      className={cn(
        'flex w-full items-start gap-2 rounded-sm px-2 py-1.5 text-left outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring',
        selected && 'bg-accent'
      )}
    >
      <span aria-hidden className={cn('mt-1.5 size-[7px] shrink-0 rounded-full', stateDot(model.state))} />
      <span className="flex min-w-0 flex-1 flex-col">
        <span id={`${id}-name`} className="truncate text-[13px] font-medium">
          {model.name}
        </span>
        {problem ? (
          <span
            id={`${id}-detail`}
            role={pickFailure ? 'alert' : undefined}
            className="text-xs text-destructive"
          >
            {problem}
          </span>
        ) : (
          <span id={`${id}-detail`} className="text-xs text-muted-foreground">
            {modelDetail(model)}
          </span>
        )}
      </span>
    </button>
  )
}

/** The chat models core found, shown in the model button's popover while core is ready. */
export function ModelPicker({
  models,
  selected,
  onPick,
  onManage
}: {
  models: ModelInfo[]
  selected: string | null
  onPick(id: string): Promise<void>
  /** "Manage models…": opens Settings › Models. */
  onManage(): void
}): React.JSX.Element {
  return (
    <>
      {models.length === 0 ? (
        <p className="text-xs text-muted-foreground">No chat models found.</p>
      ) : (
        <div role="listbox" aria-label="Models" className="flex max-h-60 flex-col gap-0.5 overflow-y-auto">
          {models.map((model) => (
            <PickerOption key={model.id} model={model} selected={model.id === selected} onPick={onPick} />
          ))}
        </div>
      )}
      <div role="separator" className="h-px bg-border" />
      <Button variant="ghost" size="sm" className="justify-start" onClick={onManage}>
        Manage models…
      </Button>
    </>
  )
}
