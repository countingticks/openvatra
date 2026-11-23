import { useId, useState } from 'react'
import { contextMax, contextMin, parseContext } from './modelText'
import { SegmentedControl } from '@app/ui/SegmentedControl'

const suggestions = [8192, 16384, 32768, 65536, 131072, 262144]
const modes = [
  { value: 'auto', label: 'Auto' },
  { value: '16384', label: '16k' },
  { value: '32768', label: '32k' },
  { value: '65536', label: '64k' },
  { value: 'custom', label: 'Custom' }
] as const
type Mode = (typeof modes)[number]['value']

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

/** The mode a stored size is shown as: a preset's segment, or Custom for any other number. */
function modeOf(value: number | null | undefined): Mode {
  if (typeof value !== 'number') return 'auto'
  return modes.find((mode) => mode.value === String(value))?.value ?? 'custom'
}

/**
 * The context size: Auto, a preset, or a number saved when the box commits (so typing "4096" does not save "4"
 * first). Custom stays shown while the user is in it, even when the typed size equals a preset.
 */
export function ContextField({ value, auto, onCommit, onDraft }: ContextFieldProps): React.JSX.Element {
  const labelId = useId()
  const [inCustom, setInCustom] = useState(false)
  const stored = typeof value === 'number' ? value : undefined
  const mode = inCustom ? 'custom' : modeOf(value)

  function pick(next: Mode): void {
    setInCustom(next === 'custom')
    if (next === 'custom') return
    if (next === 'auto') {
      // Nothing stored means Auto is already what applies; saving would only rewrite the same options.
      if (stored !== undefined) onCommit(undefined)
    } else {
      onCommit(Number(next))
    }
  }

  return (
    <div className="flex flex-col gap-1">
      <span id={labelId} className="text-xs leading-none font-medium">
        Context
      </span>
      <SegmentedControl labelledBy={labelId} value={mode} options={modes} onChange={pick} />
      {mode === 'custom' && (
        <ContextInput
          key={stored ?? 'auto'}
          stored={stored}
          initial={stored ?? auto}
          onCommit={(size) => {
            setInCustom(true)
            onCommit(size)
          }}
          onDraft={onDraft}
        />
      )}
    </div>
  )
}

function ContextInput({
  stored,
  initial,
  onCommit,
  onDraft
}: {
  stored: number | undefined
  /** What the box starts with: the stored size, else the size Auto picks. */
  initial: number
  onCommit: ContextFieldProps['onCommit']
  onDraft: ContextFieldProps['onDraft']
}): React.JSX.Element {
  const [draft, setDraft] = useState(String(initial))
  const [invalid, setInvalid] = useState(false)
  const inputId = useId()
  const listId = `${inputId}-sizes`
  const messageId = `${inputId}-message`

  function change(text: string): void {
    setDraft(text)
    setInvalid(false)
    onDraft?.(parseContext(text))
  }

  /** Leaving the box untouched saves nothing; Enter saves what is shown. */
  function commit(explicit: boolean): void {
    const size = parseContext(draft)
    setInvalid(size === undefined)
    if (size === undefined || size === stored) return
    if (explicit || String(size) !== String(initial)) onCommit(size)
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
        onBlur={() => commit(false)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') commit(true)
          if (event.key === 'Escape') {
            // The dialog would close on Escape; here it only undoes the typing.
            event.stopPropagation()
            change(String(initial))
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
