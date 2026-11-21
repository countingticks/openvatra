import { ChevronRight } from 'lucide-react'
import { useId, useState } from 'react'
import { cn } from '@app/lib/utils'

/** An answer's reasoning behind a button, collapsed until asked for. */
export function ThinkingDisclosure({
  label,
  reasoning
}: {
  label: string
  reasoning: string
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const id = useId()
  return (
    <div className="mb-3 font-sans">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((was) => !was)}
        className="inline-flex items-center gap-1 rounded-md text-sm text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
      >
        <ChevronRight aria-hidden className={cn('size-3.5 transition-transform', open && 'rotate-90')} />
        {label}
      </button>
      {open && (
        <div
          id={id}
          className="mt-2 border-l-2 pl-3 text-sm leading-relaxed whitespace-pre-wrap text-muted-foreground"
        >
          {reasoning}
        </div>
      )}
    </div>
  )
}
