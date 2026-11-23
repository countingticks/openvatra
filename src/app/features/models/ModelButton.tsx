import { useState } from 'react'
import { Popover, PopoverContent, PopoverTrigger } from '@app/ui/popover'
import { ModelPicker } from './ModelPicker'
import { useCoreState } from '@app/core/useCoreState'
import { useModels } from './useModels'
import { stateDot } from './modelText'
import { cn } from '@app/lib/utils'
import { useAppDispatch } from '@app/store/hooks'
import { settingsOpened } from '@app/store/uiSlice'
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
          return { status: 'failed to load', detail: null, dot: stateDot('error') }
        default:
          return { status: 'not loaded', detail: null, dot: stateDot('stopped') }
      }
    case 'problem':
      return { status: 'problem', detail: `Problem: ${state.reason}`, dot: stateDot('error') }
    default:
      return {
        status: 'starting',
        detail: 'Starting the models service…',
        dot: stateDot('loading')
      }
  }
}

/**
 * Status dot + the chat's model under the message box (decision 19). Click for the models: choosing one makes it
 * the chat's model (sending loads it). A sentence appears only when there is no list to look
 * at: starting, or a problem.
 */
export function ModelButton({
  model,
  onPick
}: {
  model: string | null
  onPick(id: string): Promise<void>
}): React.JSX.Element {
  const state = useCoreState()
  const dispatch = useAppDispatch()
  const [open, setOpen] = useState(false)
  // Embedding models load on demand for document search; the button and its list are about chat models.
  const models = useModels().filter((entry) => entry.kind === 'chat')
  const chosen = models.find((entry) => entry.id === model)
  const { status, detail, dot } = describe(state, chosen)
  const name = chosen?.name ?? model

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        aria-label={`Model: ${name ?? 'no model'}, ${status}. Change model`}
        className="flex h-7 items-center gap-2 rounded-sm px-2 text-xs font-medium text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring data-popup-open:bg-accent data-popup-open:text-foreground"
      >
        <span aria-hidden className={cn('size-[7px] rounded-full', dot)} />
        <span className="max-w-[120px] truncate" title={model ?? undefined}>
          {name ?? 'No model'}
        </span>
      </PopoverTrigger>
      <PopoverContent side="top" align="end" aria-label="Models service" className="w-[290px]">
        {detail && <p>{detail}</p>}
        {state?.status === 'ready' && (
          <ModelPicker
            models={models}
            selected={model}
            onPick={async (id) => {
              await onPick(id)
              setOpen(false)
            }}
            onManage={() => {
              setOpen(false)
              dispatch(settingsOpened('models'))
            }}
          />
        )}
      </PopoverContent>
    </Popover>
  )
}
