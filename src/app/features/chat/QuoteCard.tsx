import { Reply, X } from 'lucide-react'
import type { Quote } from '@app/core/generated'
import { Button } from '@app/ui/button'

/** A quote waiting in the message box: one line, a "With reply" badge when it has one, and × to remove it. */
export function QuoteCard({ quote, onRemove }: { quote: Quote; onRemove(): void }): React.JSX.Element {
  return (
    <div
      role="group"
      aria-label="Quote"
      className="flex h-8 shrink-0 items-center gap-2 rounded-lg bg-muted px-2"
    >
      <Reply aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
      <span
        title={quote.reply ? `${quote.text}\n\n${quote.reply}` : quote.text}
        className="min-w-0 flex-1 truncate text-sm text-muted-foreground"
      >
        {`“${quote.text}”`}
      </span>
      <Button variant="ghost" size="icon-sm" aria-label="Remove quote" onClick={onRemove}>
        <X aria-hidden className="size-3.5" />
      </Button>
    </div>
  )
}
