import { useState } from 'react'
import { Undo2 } from 'lucide-react'
import { Button } from '@app/ui/button'
import { Popover, PopoverContent, PopoverDescription, PopoverTrigger } from '@app/ui/popover'

function question(after: number): string {
  const what =
    after === 0
      ? 'Remove this message?'
      : after === 1
        ? 'Remove this message and the one after it?'
        : `Remove this message and the ${after} after it?`
  return `${what} Its text goes back in the message box.`
}

/** Rewind (Undo2) with its confirm popover. */
export function RewindButton({
  after,
  blocked,
  onRewind
}: {
  /** Messages that go with this one (messagesAfter). */
  after: number
  /** The chat is answering: the button is aria-disabled with "Stop the answer first". */
  blocked: boolean
  /** Rejects with an Error whose message is shown in the popover. */
  onRewind(): Promise<void>
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  function rewind(): void {
    setPending(true)
    setError(null)
    onRewind().then(
      () => {
        setPending(false)
        setOpen(false)
      },
      (reason: unknown) => {
        setPending(false)
        setError(reason instanceof Error ? reason.message : String(reason))
      }
    )
  }

  const icon = <Undo2 aria-hidden className="size-3.5" />
  if (blocked) {
    return (
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Rewind message"
        aria-disabled="true"
        title="Stop the answer first"
      >
        {icon}
      </Button>
    )
  }

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (next) setError(null)
      }}
    >
      <PopoverTrigger render={<Button variant="ghost" size="icon-sm" aria-label="Rewind message" />}>
        {icon}
      </PopoverTrigger>
      <PopoverContent side="top" align="end">
        <PopoverDescription>{question(after)}</PopoverDescription>
        {error !== null && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" size="sm" disabled={pending} onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button size="sm" disabled={pending} onClick={rewind}>
            Rewind
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  )
}
