import { X } from 'lucide-react'
import { Button } from '@app/ui/button'

/** The quote waiting in the message box: a left bar, the first two lines, and × to remove it. */
export function QuoteChip({ text, onRemove }: { text: string; onRemove(): void }): React.JSX.Element {
  return (
    <div role="group" aria-label="Quote" className="flex items-start gap-1 px-1 pt-0.5">
      <p className="line-clamp-2 min-w-0 flex-1 border-l-2 border-border pl-3 text-sm whitespace-pre-wrap text-muted-foreground">
        {text}
      </p>
      <Button variant="ghost" size="icon-sm" aria-label="Remove quote" onClick={onRemove}>
        <X aria-hidden className="size-3.5" />
      </Button>
    </div>
  )
}
