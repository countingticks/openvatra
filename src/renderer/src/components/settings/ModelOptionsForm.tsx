import { ArgsField } from '@renderer/components/settings/ArgsField'
import type { ModelOptions } from '@renderer/core/generated'

interface ModelOptionsFormProps {
  id: string
  modelId: string
  /** File name of the detected vision projector, if any. */
  projector: string | undefined
  options: ModelOptions | undefined
  /** The model's new options, or undefined when nothing is set. */
  onChange: (next: ModelOptions | undefined) => void
}

/** The options with new argument text; undefined when no field is left (nothing set). */
function withArgs(options: ModelOptions | undefined, text: string): ModelOptions | undefined {
  const next = Object.fromEntries(
    Object.entries({ ...options, args: text || undefined }).filter(([, value]) => value !== undefined)
  ) as ModelOptions
  return Object.keys(next).length > 0 ? next : undefined
}

/** A model's own settings: its arguments, and the vision projector found next to it (read-only). */
export function ModelOptionsForm({
  id,
  modelId,
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
        onCommit={(text) => onChange(withArgs(options, text))}
      />
    </div>
  )
}
