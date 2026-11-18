import { useId, useState } from 'react'
import { contextMax, contextMin, parseContext } from '@renderer/lib/modelText'
import { SegmentedControl } from '@renderer/components/settings/SegmentedControl'

const suggestions = [8192, 16384, 32768, 65536, 131072, 262144]
const modes = [
  { value: 'auto', label: 'Auto' },
  { value: 'custom', label: 'Custom' }
] as const

interface ContextFieldProps {
  /** The stored size; absent or null means Auto. */
  value: number | null | undefined
  /** The size Auto would pick: what Custom starts from. */
  auto: number
  /** Called with a new size, or undefined for Auto. */
  onCommit: (next: number | undefined) => void
  /** Called as the box changes, with the typed size when it is valid, so the hint can follow before it is saved. */
  onDraft?: (size: number | undefined) => void
}

/** The context size: Auto, or a number saved when the box loses focus (so typing "4096" does not save "4" first). */
export function ContextField({ value, auto, onCommit, onDraft }: ContextFieldProps): React.JSX.Element {
  const labelId = useId()
  const custom = typeof value === 'number'

  return (
    <div className="flex flex-col gap-1">
      <span id={labelId} className="text-xs leading-none font-medium">
        Context
      </span>
      <SegmentedControl
        labelledBy={labelId}
        value={custom ? 'custom' : 'auto'}
        options={modes}
        onChange={(mode) => onCommit(mode === 'custom' ? auto : undefined)}
      />
      {custom && <ContextInput key={value} value={value} onCommit={onCommit} onDraft={onDraft} />}
    </div>
  )
}

function ContextInput({
  value,
  onCommit,
  onDraft
}: {
  value: number
  onCommit: ContextFieldProps['onCommit']
  onDraft: ContextFieldProps['onDraft']
}): React.JSX.Element {
  const [draft, setDraft] = useState(String(value))
  const [invalid, setInvalid] = useState(false)
  const inputId = useId()
  const listId = `${inputId}-sizes`
  const messageId = `${inputId}-message`

  function change(text: string): void {
    setDraft(text)
    setInvalid(false)
    onDraft?.(parseContext(text))
  }

  function commit(): void {
    const size = parseContext(draft)
    setInvalid(size === undefined)
    if (size !== undefined && size !== value) onCommit(size)
  }

  return (
    <>
      <input
        id={inputId}
        type="text"
        inputMode="numeric"
        aria-label="Context size in tokens"
        list={listId}
        value={draft}
        onChange={(event) => change(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Enter') commit()
          if (event.key === 'Escape') {
            // The dialog would close on Escape; here it only undoes the typing.
            event.stopPropagation()
            change(String(value))
          }
        }}
        aria-invalid={invalid ? true : undefined}
        aria-describedby={invalid ? messageId : undefined}
        className="h-7 w-40 rounded-md border border-input bg-background px-2 font-mono text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring aria-invalid:border-destructive"
      />
      <datalist id={listId}>
        {suggestions.map((size) => (
          <option key={size} value={size} />
        ))}
      </datalist>
      {invalid && (
        <p id={messageId} className="text-xs text-destructive">
          A whole number from {contextMin} to {contextMax}.
        </p>
      )}
    </>
  )
}
