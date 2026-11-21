import { useRef } from 'react'
import { Button } from '@app/ui/button'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle
} from '@app/ui/dialog'

interface DeleteChatDialogProps {
  title: string
  open: boolean
  onOpenChange(open: boolean): void
  onConfirm(): void
}

/** Asks before a chat goes for good; Cancel has focus, so Enter never deletes by accident. */
export function DeleteChatDialog({
  title,
  open,
  onOpenChange,
  onConfirm
}: DeleteChatDialogProps): React.JSX.Element {
  const cancel = useRef<HTMLButtonElement>(null)

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent showCloseButton={false} initialFocus={cancel}>
        <DialogTitle>Delete &apos;{title}&apos;?</DialogTitle>
        <DialogDescription>This can&apos;t be undone.</DialogDescription>
        <DialogFooter>
          <DialogClose ref={cancel} render={<Button variant="outline" />}>
            Cancel
          </DialogClose>
          <Button variant="destructive" onClick={onConfirm}>
            Delete
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
