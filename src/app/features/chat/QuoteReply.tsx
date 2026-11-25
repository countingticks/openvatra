import { useEffect, useRef, useState } from 'react'
import { maxReplyChars } from './quoteSelection'

/** The card Quote opens where the button was: a reply to the quote. Enter adds it; Esc or a click outside closes it. */
export function QuoteReply({
  left,
  top,
  below,
  onAdd,
  onClose
}: {
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

  return (
    <div
      ref={card}
      role="dialog"
      aria-label="Reply to quote"
      style={{ left, top, transform: below ? 'translateX(-50%)' : 'translate(-50%, -100%)' }}
      className="pointer-events-auto absolute flex w-80 flex-col gap-1.5 rounded-xl border bg-popover p-2 shadow-md"
    >
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
          const trimmed = reply.trim()
          if (Array.from(trimmed).length > maxReplyChars) {
            setTooLong(true)
            return
          }
          onAdd(trimmed)
        }}
        // Grows with its text up to 4 lines (20 px each), then scrolls.
        className="field-sizing-content max-h-20 w-full resize-none overflow-y-auto bg-transparent px-1 py-1 text-sm leading-5 outline-none placeholder:text-muted-foreground"
      />
      <p className={tooLong ? 'px-1 text-xs text-destructive' : 'px-1 text-xs text-muted-foreground'}>
        {tooLong ? 'At most 4,000 characters' : 'Enter to add · Esc to cancel'}
      </p>
    </div>
  )
}
