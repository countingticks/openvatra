import { useId, useState } from 'react'
import { Label } from '@renderer/components/ui/label'
import { splitArgs } from '../../../../shared/args'
import type { ModelOptions } from '../../../../shared/settings'

interface ModelOptionsFormProps {
  id: string
  modelId: string
  options: ModelOptions | undefined
  /** The model's new options, or undefined when every field is back to its default. */
  onChange: (next: ModelOptions | undefined) => void
}

/** A model's own llama-server arguments. Saved when the box loses focus, so typing "-c 40" doesn't save "-c 4" first. */
export function ModelOptionsForm({
  id,
  modelId,
  options,
  onChange
}: ModelOptionsFormProps): React.JSX.Element {
  const [draft, setDraft] = useState(options?.args ?? '')
  const [error, setError] = useState<string>()
  const inputId = useId()
  const hintId = `${inputId}-hint`

  function commit(): void {
    const result = splitArgs(draft)
    setError(result.ok ? undefined : result.error)
    if (!result.ok) return
    // Saved as typed, minus outer spaces; an empty box means "only the arguments for every model".
    const text = draft.trim()
    const others = { ...options }
    delete others.args
    const merged = text ? { ...others, args: text } : others
    const next = Object.keys(merged).length > 0 ? merged : undefined
    if (JSON.stringify(next) !== JSON.stringify(options)) onChange(next)
  }

  return (
    <div
      id={id}
      role="group"
      aria-label={`Options for ${modelId}`}
      className="mt-2.5 flex flex-col gap-1 rounded-md bg-sidebar p-3"
    >
      <Label htmlFor={inputId} className="text-xs">
        Arguments
      </Label>
      <textarea
        id={inputId}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        rows={2}
        spellCheck={false}
        placeholder="-c 131072"
        aria-invalid={error ? true : undefined}
        aria-describedby={hintId}
        className="rounded-md border border-input bg-background px-2 py-1 font-mono text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring aria-invalid:border-destructive"
      />
      <p id={hintId} className={error ? 'text-xs text-destructive' : 'text-xs text-muted-foreground'}>
        {error ?? 'llama-server arguments for this model, e.g. -c 131072. Use "…" around values with spaces.'}
      </p>
    </div>
  )
}
