import { useEffect, useRef, useState } from 'react'
import { X } from 'lucide-react'
import type { Quote } from '@app/core/generated'
import { Button } from '@app/ui/button'
import { QuoteBlock } from './QuoteBlock'

/** A message edited in place: Enter sends, Shift+Enter breaks the line, Esc cancels. */
export function InputEditor({
  text,
  quotes,
  after,
  onSend,
  onCancel
}: {
  text: string
  quotes: Quote[]
  /** Messages that sending removes (messagesAfter); 0 shows no hint. */
  after: number
  onSend(text: string, quotes: Quote[]): Promise<void>
  onCancel(): void
}): React.JSX.Element {
  const [value, setValue] = useState(text)
  const [kept, setKept] = useState(quotes)
  const [pending, setPending] = useState(false)
  const field = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    const el = field.current
    if (!el) return
    el.focus()
    el.setSelectionRange(el.value.length, el.value.length)
  }, [])

  const sendable = value.trim() !== '' || kept.some((quote) => quote.reply)

  function send(): void {
    if (pending || !sendable) return
    setPending(true)
    // On failure the editor stays open with its text; the caller has logged the error.
    onSend(value, kept).catch(() => setPending(false))
  }

  return (
    <div className="flex w-full max-w-[80%] flex-col items-end gap-2 self-end">
      {kept.map((quote, index) => (
        <div key={index} className="flex w-full items-start gap-1">
          <div className="min-w-0 flex-1 [&_button]:line-clamp-2 [&_button]:mb-0">
            <QuoteBlock text={quote.text} />
            {quote.reply && (
              <p className="mb-0 text-sm whitespace-pre-wrap text-muted-foreground">{quote.reply}</p>
            )}
          </div>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Remove quote"
            disabled={pending}
            onClick={() => setKept(kept.filter((_, at) => at !== index))}
          >
            <X aria-hidden className="size-3.5" />
          </Button>
        </div>
      ))}
      <textarea
        ref={field}
        aria-label="Edit message"
        value={value}
        disabled={pending}
        rows={Math.min(8, Math.max(2, value.split('\n').length))}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault()
            onCancel()
          } else if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault()
            send()
          }
        }}
        className="w-full resize-none rounded-2xl border border-input bg-bubble px-4 py-2.5 text-[15px] leading-[1.55] outline-none focus-visible:ring-2 focus-visible:ring-ring"
      />
      {after > 0 && (
        <p className="text-xs text-muted-foreground">
          {after === 1
            ? 'Sending removes the message after it.'
            : `Sending removes the ${after} messages after it.`}
        </p>
      )}
      <div className="flex gap-2">
        <Button variant="ghost" size="sm" disabled={pending} onClick={onCancel}>
          Cancel
        </Button>
        <Button size="sm" disabled={pending} onClick={send}>
          Send
        </Button>
      </div>
    </div>
  )
}
