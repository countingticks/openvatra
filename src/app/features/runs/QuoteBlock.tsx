import { useState } from 'react'
import { cn } from '@app/lib/utils'

/** A message's quote in its bubble: a muted block with a left bar, 3 lines until clicked. */
export function QuoteBlock({ text }: { text: string }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  return (
    <button
      type="button"
      aria-expanded={open}
      onClick={() => setOpen(!open)}
      className={cn(
        'mb-2 block w-full cursor-pointer border-l-2 border-border pl-3 text-left text-sm whitespace-pre-wrap text-muted-foreground',
        !open && 'line-clamp-3'
      )}
    >
      {text}
    </button>
  )
}
