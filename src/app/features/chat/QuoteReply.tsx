import { useEffect, useRef, useState } from 'react'
import { ArrowUp } from 'lucide-react'
import { maxReplyChars } from './quoteSelection'

/** The card Quote opens where the button was: a reply to the quote. Enter adds it; Esc or a click outside closes it. */
export function QuoteReply({
  text,
  left,
  top,
  below,
  onAdd,
  onClose
}: {
  /** The quoted text, shown above the reply. */
  text: string
  left: number
  top: number
  below: boolean
  /** The trimmed reply; '' when there is none. */
  onAdd(reply: string): void
  onClose(): void
}): React.JSX.Element {
  const [reply, setReply] = useState('')
  const [tooLong, setTooLong] = useState(false)
  const card = useRef<HTMLDivElement>(null)
  const field = useRef<HTMLTextAreaElement>(null)
  // Read from the listener, which is registered once.
  const close = useRef(onClose)
  useEffect(() => {
    close.current = onClose
  })

  useEffect(() => {
    field.current?.focus()
    const onDown = (event: PointerEvent): void => {
      if (!card.current?.contains(event.target as Node)) close.current()
    }
    document.addEventListener('pointerdown', onDown)
    return () => document.removeEventListener('pointerdown', onDown)
  }, [])

  function add(): void {
    const trimmed = reply.trim()
    if (Array.from(trimmed).length > maxReplyChars) {
      setTooLong(true)
      return
    }
    onAdd(trimmed)
  }

  return (
    <div
      ref={card}
      role="dialog"
      aria-label="Reply to quote"
      style={{ left, top, transform: below ? 'translateX(-50%)' : 'translate(-50%, -100%)' }}
      className="pointer-events-auto absolute flex w-80 flex-col gap-1.5 rounded-xl border bg-popover p-2 shadow-md"
    >
      <p className="ml-1 line-clamp-2 border-l-2 border-border pl-3 text-sm whitespace-pre-wrap text-muted-foreground">
        {text}
      </p>
      <div className="flex items-end gap-1">
        <textarea
          ref={field}
          rows={1}
          value={reply}
          aria-label="Reply to this quote"
          placeholder="Reply to this quote…"
          onChange={(event) => {
            setReply(event.target.value)
            setTooLong(false)
          }}
          onKeyDown={(event) => {
            if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return
            event.preventDefault()
            add()
          }}
          // Grows with its text up to 4 lines (20 px each), then scrolls.
          className="field-sizing-content max-h-20 min-w-0 flex-1 resize-none overflow-y-auto bg-transparent px-1 py-1 text-sm leading-5 outline-none placeholder:text-muted-foreground"
        />
        {reply.trim() !== '' && (
          <button
            type="button"
            aria-label="Add quote (Enter)"
            title="Add quote (Enter)"
            onClick={add}
            className="grid size-[30px] shrink-0 place-items-center rounded-[10px] text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
          >
            <ArrowUp aria-hidden className="size-4" strokeWidth={2.4} />
          </button>
        )}
      </div>
      {tooLong && <p className="px-1 text-xs text-destructive">At most 4,000 characters</p>}
    </div>
  )
}
