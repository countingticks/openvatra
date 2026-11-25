import { useEffect, useRef, useState } from 'react'
import { Button } from '@app/ui/button'
import { maxQuoteChars, quotableText } from './quoteSelection'

/** What the button is placed from: its size is only estimated, as it is measured after it shows. */
const gap = 8
const halfWidth = 32
const height = 28

interface Placed {
  text: string
  left: number
  top: number
  below: boolean
}

/** The floating Quote button for the conversation's selection. */
export function QuoteButton({
  container,
  onQuote
}: {
  /** The conversation's scroller; the button is placed inside the area that holds it. */
  container: React.RefObject<HTMLElement | null>
  onQuote(text: string): void
}): React.JSX.Element | null {
  const [placed, setPlaced] = useState<Placed | null>(null)
  // The button is placed against this layer, which covers the screen's positioned root.
  const layer = useRef<HTMLDivElement>(null)

  useEffect(() => {
    function update(): void {
      const scroller = container.current
      const frame = layer.current
      const selection = document.getSelection()
      const text = scroller ? quotableText(selection, scroller) : null
      if (!scroller || !frame || !selection || text === null) {
        setPlaced(null)
        return
      }
      const range = selection.getRangeAt(0)
      const rects = range.getClientRects()
      const end = rects.length > 0 ? rects[rects.length - 1] : range.getBoundingClientRect()
      const box = frame.getBoundingClientRect()
      const area = scroller.getBoundingClientRect()
      const below = end.top - gap - height < area.top
      const minLeft = area.left - box.left + halfWidth
      const maxLeft = Math.max(minLeft, area.right - box.left - halfWidth)
      setPlaced({
        text,
        below,
        left: Math.min(maxLeft, Math.max(minLeft, end.right - box.left)),
        top: (below ? end.bottom + gap : end.top - gap) - box.top
      })
    }
    const hide = (): void => setPlaced(null)
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') hide()
    }
    const scroller = container.current
    document.addEventListener('selectionchange', update)
    document.addEventListener('keydown', onKey)
    scroller?.addEventListener('scroll', hide)
    return () => {
      document.removeEventListener('selectionchange', update)
      document.removeEventListener('keydown', onKey)
      scroller?.removeEventListener('scroll', hide)
    }
  }, [container])

  const tooLong = placed !== null && Array.from(placed.text).length > maxQuoteChars
  return (
    <div ref={layer} className="pointer-events-none absolute inset-0 z-10">
      {placed !== null && (
        <Button
          variant="outline"
          size="sm"
          aria-disabled={tooLong || undefined}
          title={tooLong ? 'Select at most 4,000 characters to quote' : undefined}
          // The selection must survive until the click.
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => {
            if (tooLong) return
            onQuote(placed.text)
            document.getSelection()?.removeAllRanges()
            setPlaced(null)
          }}
          style={{
            left: placed.left,
            top: placed.top,
            transform: placed.below ? 'translateX(-50%)' : 'translate(-50%, -100%)'
          }}
          className="pointer-events-auto absolute bg-popover shadow-sm dark:bg-popover"
        >
          Quote
        </Button>
      )}
    </div>
  )
}
