import { useEffect, useRef, useState } from 'react'
import { Button } from '@app/ui/button'
import { useResumeDownloadMutation } from '@app/core/generated'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from '@app/ui/dialog'
import { useCoreState } from '@app/core/useCoreState'
import { useSetup } from './useSetup'
import { progressText } from './setupText'
import type { DownloadItem } from '@app/core/types'

/**
 * Once per start: if downloads were left unfinished by the last run, offers to continue them. "Left over" means
 * paused in the first non-empty queue we see. A download that pauses later in this run (lost connection) must have
 * been active before, so the queue was already non-empty and nothing is offered for it.
 */
export function ResumeDownloadsDialog(): React.JSX.Element | null {
  const ready = useCoreState()?.status === 'ready'
  const { catalog, downloads } = useSetup()
  const decided = useRef(false)
  const [offered, setOffered] = useState<DownloadItem[]>([])
  const [resumeDownload] = useResumeDownloadMutation()

  useEffect(() => {
    // The catalog is needed for the names; wait for it so the dialog never shows raw ids.
    if (decided.current || !ready || !catalog || downloads.length === 0) return
    decided.current = true
    setOffered(downloads.filter((item) => item.state === 'paused'))
  }, [ready, catalog, downloads])

  if (offered.length === 0) return null
  // A Hugging Face download has no catalog entry: its file name (or at worst its id) is what there is to show.
  const nameOf = (item: DownloadItem): string =>
    catalog?.entries.find((entry) => entry.id === item.id)?.name ?? (item.name || item.id)

  function resume(): void {
    for (const item of offered) {
      resumeDownload({ id: item.id })
        .unwrap()
        .catch((error: unknown) => console.error('Could not resume a download', error))
    }
    setOffered([])
  }

  const [only] = offered
  return (
    <Dialog open onOpenChange={(open) => !open && setOffered([])}>
      <DialogContent showCloseButton={false} className="flex flex-col gap-3 sm:max-w-md">
        <DialogTitle>
          {offered.length === 1 ? 'Finish downloading?' : 'Finish downloading these?'}
        </DialogTitle>
        {offered.length === 1 && only ? (
          <DialogDescription>
            {nameOf(only)} didn&apos;t finish downloading ({progressText(only)}). Resume now?
          </DialogDescription>
        ) : (
          <>
            <DialogDescription>These models didn&apos;t finish downloading. Resume now?</DialogDescription>
            <ul className="flex flex-col gap-1 text-sm">
              {offered.map((item) => (
                <li key={item.id}>
                  {nameOf(item)} ({progressText(item)})
                </li>
              ))}
            </ul>
          </>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => setOffered([])}>
            Not now
          </Button>
          <Button onClick={resume}>{offered.length === 1 ? 'Resume' : 'Resume all'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
