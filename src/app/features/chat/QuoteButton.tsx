import { useEffect, useRef, useState } from 'react'
import type { Quote } from '@app/core/generated'
import { Button } from '@app/ui/button'
import { maxQuoteChars, quotableText } from './quoteSelection'
import { QuoteReply } from './QuoteReply'

/** What the button and the card are placed from: their sizes are only estimated, as they are measured after they show. */
const gap = 8
const buttonHalfWidth = 32
const buttonHeight = 28
const cardHalfWidth = 160
const cardHeight = 132

interface Spot {
  left: number
  top: number
  below: boolean
}

interface Placed {
  text: string
  button: Spot
  card: Spot
}

/** The floating Quote button for the conversation's selection, and the reply card it opens in its place. */
export function QuoteButton({
  container,
  onQuote
}: {
  /** The conversation's scroller; the button is placed inside the area that holds it. */
  container: React.RefObject<HTMLElement | null>
  onQuote(quote: Quote): void
}): React.JSX.Element | null {
  const [placed, setPlaced] = useState<Placed | null>(null)
  const [replying, setReplying] = useState(false)
  // The button is placed against this layer, which covers the screen's positioned root.
  const layer = useRef<HTMLDivElement>(null)
  // Read from the listeners, which are not re-registered when the state changes.
  const card = useRef(false)
  useEffect(() => {
    card.current = replying
  })

  useEffect(() => {
    function spot(rect: DOMRect, box: DOMRect, area: DOMRect, halfWidth: number, height: number): Spot {
      const below = rect.top - gap - height < area.top
      const minLeft = area.left - box.left + halfWidth
      const maxLeft = Math.max(minLeft, area.right - box.left - halfWidth)
      return {
        below,
        left: Math.min(maxLeft, Math.max(minLeft, (rect.left + rect.right) / 2 - box.left)),
        top: (below ? rect.bottom + gap : rect.top - gap) - box.top
      }
    }
    function update(): void {
      // Focusing the reply clears the selection: the card keeps the text it captured.
      if (card.current) return
      const scroller = container.current
      const frame = layer.current
      const selection = document.getSelection()
      const text = scroller ? quotableText(selection, scroller) : null
      if (!scroller || !frame || !selection || text === null) {
        setPlaced(null)
        return
      }
      const rect = selection.getRangeAt(0).getBoundingClientRect()
      const box = frame.getBoundingClientRect()
      const area = scroller.getBoundingClientRect()
      setPlaced({
        text,
        button: spot(rect, box, area, buttonHalfWidth, buttonHeight),
        card: spot(rect, box, area, cardHalfWidth, cardHeight)
      })
    }
    const hide = (): void => {
      setPlaced(null)
      setReplying(false)
    }
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
  const blocked = tooLong
  const reason = 'Select at most 4,000 characters to quote'
  return (
    <div ref={layer} className="pointer-events-none absolute inset-0 z-10">
      {placed !== null && !replying && (
        <Button
          variant="outline"
          size="sm"
          aria-disabled={blocked || undefined}
          title={blocked ? reason : undefined}
          // The selection must survive until the click.
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => {
            if (!blocked) setReplying(true)
          }}
          style={{
            left: placed.button.left,
            top: placed.button.top,
            transform: placed.button.below ? 'translateX(-50%)' : 'translate(-50%, -100%)'
          }}
          // Opaque on hover, as the model and context buttons are: outline's dark hover is see-through.
          className="pointer-events-auto absolute bg-popover shadow-sm hover:bg-accent dark:bg-popover dark:hover:bg-accent"
        >
          Quote
        </Button>
      )}
      {placed !== null && replying && (
        <QuoteReply
          text={placed.text}
          left={placed.card.left}
          top={placed.card.top}
          below={placed.card.below}
          onAdd={(reply) => {
            onQuote({ text: placed.text, ...(reply ? { reply } : {}) })
            document.getSelection()?.removeAllRanges()
            setPlaced(null)
            setReplying(false)
          }}
          onClose={() => {
            setPlaced(null)
            setReplying(false)
          }}
        />
      )}
    </div>
  )
}
