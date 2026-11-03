import { ArgsField } from '@renderer/components/settings/ArgsField'
import type { ModelOptions } from '../../../../shared/settings'

interface ModelOptionsFormProps {
  id: string
  modelId: string
  /** File name of the detected vision projector, if any. */
  projector: string | undefined
  options: ModelOptions | undefined
  /** The model's new options, or undefined when nothing is set. */
  onChange: (next: ModelOptions | undefined) => void
}

/** A model's own settings: its arguments, and the vision projector found next to it (read-only). */
export function ModelOptionsForm({
  id,
  modelId,
  projector,
  options,
  onChange
}: ModelOptionsFormProps): React.JSX.Element {
  return (
    <div
      id={id}
      role="group"
      aria-label={`Options for ${modelId}`}
      className="mt-2.5 flex flex-col gap-3 rounded-md bg-sidebar p-3"
    >
      <ArgsField
        label="Arguments"
        value={options?.args ?? ''}
        placeholder="-c 131072"
        hint="llama-server arguments, e.g. -c 131072"
        onCommit={(text) => onChange(text ? { args: text } : undefined)}
      />

      <div className="flex flex-col gap-0.5">
        <span className="text-xs font-medium">Vision projector</span>
        <p className="truncate text-xs text-muted-foreground" title={projector}>
          {projector ? `${projector} (--no-mmproj skips it)` : 'None found.'}
        </p>
      </div>
    </div>
  )
}
