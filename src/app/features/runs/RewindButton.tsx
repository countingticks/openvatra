import { useState } from 'react'
import { Undo2 } from 'lucide-react'
import { Button } from '@app/ui/button'

/** Rewind (Undo2): removes this message and what came after it on the click, no confirm (decision 25). */
export function RewindButton({
  blocked,
  onRewind
}: {
  /** The chat is answering: the button is aria-disabled with "Stop the answer first". */
  blocked: boolean
  onRewind(): Promise<void>
}): React.JSX.Element {
  const [pending, setPending] = useState(false)

  function rewind(): void {
    if (blocked) return
    setPending(true)
    void onRewind().finally(() => setPending(false))
  }

  return (
    <Button
      variant="ghost"
      size="icon-sm"
      aria-label="Rewind message"
      aria-disabled={blocked || undefined}
      title={blocked ? 'Stop the answer first' : undefined}
      disabled={pending}
      onClick={rewind}
    >
      <Undo2 aria-hidden className="size-3.5" />
    </Button>
  )
}
