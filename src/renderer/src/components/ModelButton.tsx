import { useState } from 'react'
import { Popover, PopoverContent, PopoverTrigger } from '@renderer/components/ui/popover'
import { Button } from '@renderer/components/ui/button'
import { ModelPicker } from '@renderer/components/ModelPicker'
import { useCoreState } from '@renderer/hooks/useCoreState'
import { useModels } from '@renderer/hooks/useModels'
import { cn } from '@renderer/lib/utils'
import { useAppDispatch } from '@renderer/store/hooks'
import { settingsOpened } from '@renderer/store/uiSlice'
import type { CoreState, ModelInfo } from '../../../shared/core'

/** The words come first so the dot's colour is never the only signal (colour-blind users, screen readers). */
function describe(
  state: CoreState | null,
  active: ModelInfo | undefined
): { label: string; detail: string; dot: string } {
  switch (state?.status) {
    case 'ready':
      if (active?.state === 'loading')
        return {
          label: 'Loading',
          detail: `Loading ${active.id}…`,
          dot: 'animate-pulse bg-primary in-data-[motion=reduce]:animate-none'
        }
      return {
        label: 'Ready',
        detail: active ? `Ready — ${active.id} loaded` : 'Ready — no model loaded',
        dot: 'bg-primary'
      }
    case 'problem':
      return { label: 'Problem', detail: `Problem: ${state.reason}`, dot: 'bg-destructive' }
    default:
      return {
        label: 'Starting',
        detail: 'Starting the models service…',
        // Pulses only while something is happening; the app's motion setting (data-motion on <html>) turns it off.
        dot: 'animate-pulse bg-primary in-data-[motion=reduce]:animate-none'
      }
  }
}

/** A failed action has nothing useful to show here; log it (main copies page errors into main.log). */
function run(action: () => Promise<void>): void {
  action().catch((error) => console.error('Model button action failed', error))
}

/**
 * Status dot + model name under the message box; click for the state in words and the service's actions.
 * The name is the model that is loaded or loading (the first, if several), else "No model".
 */
export function ModelButton(): React.JSX.Element {
  const state = useCoreState()
  const dispatch = useAppDispatch()
  const [open, setOpen] = useState(false)
  const models = useModels()
  const active =
    models.find((model) => model.state === 'ready') ?? models.find((model) => model.state === 'loading')
  const { label, detail, dot } = describe(state, active)
  const name = state?.status === 'ready' && active ? active.id : 'No model'

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        aria-label={`Model: ${name === 'No model' ? 'no model' : name}, ${label}`}
        className="flex h-8 items-center gap-2 rounded-sm px-2 text-sm text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring data-popup-open:bg-accent data-popup-open:text-foreground"
      >
        <span aria-hidden className={cn('size-2 rounded-full', dot)} />
        {name}
      </PopoverTrigger>
      <PopoverContent side="top" align="end" aria-label="Models service">
        <p>{detail}</p>
        {state?.status === 'ready' && <ModelPicker models={models} />}
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" onClick={() => run(window.api.core.restart)}>
            Restart
          </Button>
          <Button variant="outline" size="sm" onClick={() => run(window.api.core.openLog)}>
            Open log
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setOpen(false)
              dispatch(settingsOpened('models'))
            }}
          >
            Model settings…
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  )
}
