import { useState } from 'react'
import { Popover, PopoverContent, PopoverTrigger } from '@app/ui/popover'
import { Button } from '@app/ui/button'
import { CudaEngineOffer } from './CudaEngineOffer'
import { ModelPicker } from './ModelPicker'
import { useCoreState } from '@app/core/useCoreState'
import { useModels } from './useModels'
import { stateDot } from './modelText'
import { cn } from '@app/lib/utils'
import { usePlatform } from '@app/platform/usePlatform'
import { useAppDispatch } from '@app/store/hooks'
import { modelsDialogOpened, settingsOpened } from '@app/store/uiSlice'
import type { CoreState } from '@shared/core'
import type { ModelInfo } from '@app/core/types'

/** The words come first so the dot's colour is never the only signal (colour-blind users, screen readers). */
function describe(
  state: CoreState | null,
  model: ModelInfo | undefined
): { status: string; detail: string | null; dot: string } {
  switch (state?.status) {
    case 'ready':
      switch (model?.state) {
        case 'ready':
          return { status: 'loaded', detail: null, dot: stateDot('ready') }
        case 'loading':
          return { status: 'loading', detail: null, dot: stateDot('loading') }
        case 'error':
          return { status: 'failed to load', detail: null, dot: stateDot('stopped') }
        default:
          return { status: 'not loaded', detail: null, dot: stateDot('stopped') }
      }
    case 'problem':
      return { status: 'problem', detail: `Problem: ${state.reason}`, dot: 'bg-destructive' }
    default:
      return {
        status: 'starting',
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
 * Status dot + the chat's model under the message box (decision 19). Click for the models: choosing one makes it
 * the chat's model, and each row loads or unloads its model. A sentence appears only when there is no list to look
 * at: starting, or a problem.
 */
export function ModelButton({
  model,
  onPick
}: {
  model: string | null
  onPick(id: string): Promise<void>
}): React.JSX.Element {
  const { core } = usePlatform()
  const state = useCoreState()
  const dispatch = useAppDispatch()
  const [open, setOpen] = useState(false)
  // Embedding models load on demand for document search; the button and its list are about chat models.
  const models = useModels().filter((entry) => entry.kind === 'chat')
  const { status, detail, dot } = describe(
    state,
    models.find((entry) => entry.id === model)
  )

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        aria-label={`Model: ${model ?? 'no model'}, ${status}. Change model`}
        className="flex h-7 items-center gap-2 rounded-sm px-2 text-xs font-medium text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring data-popup-open:bg-accent data-popup-open:text-foreground"
      >
        <span aria-hidden className={cn('size-[7px] rounded-full', dot)} />
        {model ?? 'No model'}
      </PopoverTrigger>
      <PopoverContent side="top" align="end" aria-label="Models service">
        {detail && <p>{detail}</p>}
        {state?.status === 'ready' && (
          <ModelPicker
            models={models}
            selected={model}
            onPick={async (id) => {
              await onPick(id)
              setOpen(false)
            }}
          />
        )}
        <CudaEngineOffer variant="card" />
        <div className="flex flex-wrap gap-2">
          {core.restart && (
            <Button variant="outline" size="sm" onClick={() => run(async () => core.restart?.())}>
              Restart
            </Button>
          )}
          {core.openLog && (
            <Button variant="outline" size="sm" onClick={() => run(async () => core.openLog?.())}>
              Open log
            </Button>
          )}
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
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setOpen(false)
              dispatch(modelsDialogOpened())
            }}
          >
            Get more models…
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  )
}
