import { ArgsField } from '@renderer/components/settings/ArgsField'
import { ContextField } from '@renderer/components/settings/ContextField'
import { PlacementSelect } from '@renderer/components/settings/PlacementSelect'
import type { ModelOptions } from '@renderer/core/generated'
import type { ModelInfo } from '@renderer/core/types'

interface ModelOptionsFormProps {
  id: string
  model: ModelInfo
  options: ModelOptions | undefined
  /** The model's new options, or undefined when nothing is set. */
  onChange: (next: ModelOptions | undefined) => void
}

/** What Custom starts from when core has no choice for the model (its shape is unknown). */
const fallbackContext = 16384

/** The options with some fields replaced; undefined keys are dropped, and undefined is returned when none is left. */
function withFields(
  options: ModelOptions | undefined,
  fields: Partial<ModelOptions>
): ModelOptions | undefined {
  const next = Object.fromEntries(
    Object.entries({ ...options, ...fields }).filter(([, value]) => value !== undefined)
  ) as ModelOptions
  return Object.keys(next).length > 0 ? next : undefined
}

/** A model's own settings: context size and placement (chat models), and its arguments. */
export function ModelOptionsForm({ id, model, options, onChange }: ModelOptionsFormProps): React.JSX.Element {
  return (
    <div
      id={id}
      role="group"
      aria-label={`Options for ${model.id}`}
      className="mt-2.5 flex flex-col gap-3 rounded-md bg-sidebar p-3"
    >
      {model.kind === 'chat' && (
        <>
          <ContextField
            value={options?.context}
            auto={model.context?.context ?? fallbackContext}
            onCommit={(context) => onChange(withFields(options, { context }))}
          />
          <PlacementSelect
            value={options?.placement}
            moe={model.moe}
            onChange={(placement) => onChange(withFields(options, { placement }))}
          />
        </>
      )}
      <ArgsField
        label="Arguments"
        value={options?.args ?? ''}
        placeholder="--jinja --temp 0.7"
        hint="llama-server arguments, e.g. --temp 0.7"
        onCommit={(text) => onChange(withFields(options, { args: text || undefined }))}
      />
    </div>
  )
}
