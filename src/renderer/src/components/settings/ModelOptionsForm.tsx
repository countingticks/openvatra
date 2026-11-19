import { useEffect, useState } from 'react'
import { ArgsField } from '@renderer/components/settings/ArgsField'
import { ContextField } from '@renderer/components/settings/ContextField'
import { PlacementSelect } from '@renderer/components/settings/PlacementSelect'
import { useGetHardwareQuery, useGetModelFitQuery, type ModelOptions } from '@app/core/generated'
import { fitHint } from '@renderer/lib/modelText'
import type { ModelInfo } from '@app/core/types'

interface ModelOptionsFormProps {
  id: string
  model: ModelInfo
  options: ModelOptions | undefined
  /** Whether the options are open: a folded form asks core nothing. */
  expanded: boolean
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

/** How long after the last keystroke the hint asks core about the typed size. */
const draftDelayMs = 300

interface TypedSize {
  /** The stored size when it was typed: a draft only counts while the stored size is still that one. */
  stored: ModelOptions['context']
  size: number
}

/** The sentence under Placement: what the chosen size and placement mean for this PC, asked of core as they change. */
function FitHint({
  modelId,
  context,
  placement,
  expanded
}: {
  modelId: string
  expanded: boolean
  context: number | null | undefined
  placement: ModelOptions['placement']
}): React.JSX.Element {
  const fit = useGetModelFitQuery(
    {
      id: modelId,
      context: typeof context === 'number' ? String(context) : 'auto',
      placement: placement ?? 'auto'
    },
    { skip: !expanded }
  )
  const hardware = useGetHardwareQuery()
  const text = fit.currentData ? fitHint(fit.currentData, hardware.data?.gpu?.totalBytes ?? null) : ''

  return (
    <p aria-live="polite" className="min-h-4 text-xs text-muted-foreground">
      {text}
    </p>
  )
}

/** A model's own settings: context size and placement (chat models), and its arguments. */
export function ModelOptionsForm({
  id,
  model,
  options,
  expanded,
  onChange
}: ModelOptionsFormProps): React.JSX.Element {
  const stored = options?.context
  const [typed, setTyped] = useState<TypedSize>()
  const [settled, setSettled] = useState<TypedSize>()
  // Typing asks core after a pause, so "131072" is not asked as 1, 13, 131 ...; other changes ask at once.
  useEffect(() => {
    const timer = setTimeout(() => setSettled(typed), draftDelayMs)
    return () => clearTimeout(timer)
  }, [typed])
  const asked = settled && settled.stored === stored ? settled.size : stored

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
            onDraft={(size) => setTyped(size === undefined ? undefined : { stored, size })}
          />
          <PlacementSelect
            value={options?.placement}
            moe={model.moe}
            onChange={(placement) => onChange(withFields(options, { placement }))}
          />
          <FitHint modelId={model.id} context={asked} placement={options?.placement} expanded={expanded} />
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
