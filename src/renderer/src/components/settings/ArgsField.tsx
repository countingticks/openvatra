import { useId, useState } from 'react'
import { Label } from '@renderer/components/ui/label'
import { splitArgs } from '../../../../shared/args'

interface ArgsFieldProps {
  label: string
  /** The saved text; the box starts from it. */
  value: string
  placeholder: string
  hint: string
  /** Called with the trimmed text, only when it splits cleanly and differs from `value`. */
  onCommit: (text: string) => void
}

/**
 * A llama-server arguments box. Saved when it loses focus, so typing "-c 40" doesn't save "-c 4" first; text that
 * doesn't split (open quote, a flag OpenVatra sets itself) is explained under the box and never saved.
 */
export function ArgsField({ label, value, placeholder, hint, onCommit }: ArgsFieldProps): React.JSX.Element {
  const [draft, setDraft] = useState(value)
  const [error, setError] = useState<string>()
  const inputId = useId()
  const hintId = `${inputId}-hint`

  function commit(): void {
    const result = splitArgs(draft)
    setError(result.ok ? undefined : result.error)
    if (!result.ok) return
    const text = draft.trim()
    if (text !== value) onCommit(text)
  }

  return (
    <div className="flex flex-col gap-1">
      <Label htmlFor={inputId} className="text-xs">
        {label}
      </Label>
      <textarea
        id={inputId}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        rows={1}
        spellCheck={false}
        placeholder={placeholder}
        aria-invalid={error ? true : undefined}
        aria-describedby={hintId}
        className="min-h-6.5 resize-y rounded-md border border-input bg-background px-2 py-1 font-mono text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring aria-invalid:border-destructive"
      />
      <p id={hintId} className={error ? 'text-xs text-destructive' : 'text-xs text-muted-foreground'}>
        {error ?? hint}
      </p>
    </div>
  )
}
