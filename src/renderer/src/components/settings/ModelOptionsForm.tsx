import { useId, useState } from 'react'
import { Label } from '@renderer/components/ui/label'
import type { ModelOptions } from '../../../../shared/settings'

interface ModelOptionsFormProps {
  id: string
  modelId: string
  options: ModelOptions | undefined
  /** The model's new options, or undefined when every field is back to its default. */
  onChange: (next: ModelOptions | undefined) => void
}

type Field = 'contextSize' | 'gpuLayers' | 'extraArgs'
type Draft = Record<Field, string>
type Errors = Partial<Record<Field, string>>

const fields: { field: Field; label: string; hint: string }[] = [
  {
    field: 'contextSize',
    label: 'Context size',
    hint: 'Tokens the model sees at once. Empty: the model’s own.'
  },
  { field: 'gpuLayers', label: 'GPU layers', hint: '0 runs on the CPU only. Empty: llama-server decides.' },
  { field: 'extraArgs', label: 'Extra arguments', hint: 'One per line, passed to llama-server as written.' }
]

const wholeNumber = /^\d+$/

/** Reads the typed text into options; anything that isn't valid becomes an error and nothing is saved. */
function parse(draft: Draft): { options: ModelOptions; errors: Errors } {
  const options: ModelOptions = {}
  const errors: Errors = {}

  const contextSize = draft.contextSize.trim()
  if (contextSize && (!wholeNumber.test(contextSize) || Number(contextSize) === 0))
    errors.contextSize = 'A whole number above 0, or empty.'
  else if (contextSize) options.contextSize = Number(contextSize)

  const gpuLayers = draft.gpuLayers.trim()
  if (gpuLayers && !wholeNumber.test(gpuLayers)) errors.gpuLayers = 'A whole number, or empty.'
  else if (gpuLayers) options.gpuLayers = Number(gpuLayers)

  // A list, never one command line: no quoting rules, and nothing a shell could read differently.
  const extraArgs = draft.extraArgs
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
  if (extraArgs.length > 50) errors.extraArgs = 'At most 50 arguments.'
  else if (extraArgs.some((arg) => arg.length > 1000)) errors.extraArgs = 'An argument is too long.'
  else if (extraArgs.length > 0) options.extraArgs = extraArgs

  return { options, errors }
}

/** A model's llama-server options. Saved when a field loses focus, so typing "40" doesn't save "4" first. */
export function ModelOptionsForm({
  id,
  modelId,
  options,
  onChange
}: ModelOptionsFormProps): React.JSX.Element {
  const [draft, setDraft] = useState<Draft>({
    contextSize: options?.contextSize?.toString() ?? '',
    gpuLayers: options?.gpuLayers?.toString() ?? '',
    extraArgs: options?.extraArgs?.join('\n') ?? ''
  })
  const [errors, setErrors] = useState<Errors>({})
  const baseId = useId()

  function commit(): void {
    const parsed = parse(draft)
    setErrors(parsed.errors)
    if (Object.keys(parsed.errors).length > 0) return
    const next = Object.keys(parsed.options).length > 0 ? parsed.options : undefined
    if (JSON.stringify(next) !== JSON.stringify(options)) onChange(next)
  }

  return (
    <div
      id={id}
      role="group"
      aria-label={`Options for ${modelId}`}
      className="mt-2.5 grid grid-cols-2 gap-3 rounded-md bg-sidebar p-3"
    >
      {fields.map(({ field, label, hint }) => {
        const inputId = `${baseId}-${field}`
        const hintId = `${inputId}-hint`
        const error = errors[field]
        const props = {
          id: inputId,
          value: draft[field],
          onChange: (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
            setDraft((current) => ({ ...current, [field]: event.target.value })),
          onBlur: commit,
          'aria-invalid': error ? true : undefined,
          'aria-describedby': hintId,
          className:
            'rounded-md border border-input bg-background px-2 py-1 font-mono text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring aria-invalid:border-destructive'
        }
        return (
          <div
            key={field}
            className={field === 'extraArgs' ? 'col-span-2 flex flex-col gap-1' : 'flex flex-col gap-1'}
          >
            <Label htmlFor={inputId} className="text-xs">
              {label}
            </Label>
            {field === 'extraArgs' ? (
              <textarea {...props} rows={3} spellCheck={false} />
            ) : (
              <input {...props} inputMode="numeric" placeholder="Default" />
            )}
            <p id={hintId} className={error ? 'text-xs text-destructive' : 'text-xs text-muted-foreground'}>
              {error ?? hint}
            </p>
          </div>
        )
      })}
    </div>
  )
}
