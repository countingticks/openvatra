import { useState } from 'react'
import { Button } from '@app/ui/button'
import {
  useCancelDownloadMutation,
  useResumeDownloadMutation,
  useStartDownloadMutation,
  type Group
} from '@app/core/generated'
import { downloadPercent } from './hfText'
import { failureReason, formatSize, softButton } from './modelText'
import type { DownloadItem } from '@app/core/types'

interface HfGroupSlotProps {
  /** owner/name */
  repo: string
  group: Group
  diskFreeBytes: number | null
  /** The group's place in the download queue, if it has one. */
  item: DownloadItem | undefined
}

/** Room a download leaves free on the disk, as core's catalog does. */
const spare = 2 * 1024 ** 3

/**
 * The right end of a quant's line: Download, its progress, or Installed. The notes it may need (the Too big question,
 * the missing space, a refusal) are its own lines below, so it renders into the line's flex-wrap row.
 */
export function HfGroupSlot({ repo, group, diskFreeBytes, item }: HfGroupSlotProps): React.JSX.Element {
  const [confirming, setConfirming] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const [startDownload] = useStartDownloadMutation()
  const [cancelDownload] = useCancelDownloadMutation()
  const [resumeDownload] = useResumeDownloadMutation()

  const label = `${repo} ${group.quant}`
  const installed = group.installed || item?.state === 'done'
  const shortBytes =
    diskFreeBytes !== null && group.sizeBytes + spare > diskFreeBytes
      ? group.sizeBytes + spare - diskFreeBytes
      : 0

  const act = (action: () => Promise<unknown>): void => {
    setProblem(null)
    setConfirming(false)
    action().catch((error: unknown) => setProblem(failureReason(error)))
  }
  const download = (): void =>
    act(() => startDownload({ startDownload: { hf: { repo, quant: group.quant } } }).unwrap())

  const running = item?.state === 'queued' || item?.state === 'downloading' || item?.state === 'verifying'
  const stuck = item?.state === 'paused' || item?.state === 'error'

  return (
    <>
      <span className="ml-auto flex shrink-0 items-center justify-end gap-2">
        {installed ? (
          <span className="text-xs text-muted-foreground">Installed</span>
        ) : !item ? (
          <Button
            size="sm"
            variant={group.fit === 'tooBig' ? 'outline' : 'default'}
            className={group.fit === 'tooBig' ? undefined : softButton}
            aria-label={`Download ${label}`}
            disabled={shortBytes > 0}
            onClick={() => (group.fit === 'tooBig' ? setConfirming(true) : download())}
          >
            Download
          </Button>
        ) : (
          <>
            {running && (
              <>
                <progress
                  aria-label="Download progress"
                  className="h-1.5 w-[120px] accent-primary"
                  max={100}
                  value={downloadPercent(item)}
                />
                <span className="w-9 text-right text-xs text-muted-foreground">{downloadPercent(item)}%</span>
              </>
            )}
            {stuck && (
              <Button
                variant="outline"
                size="xs"
                aria-label={`Resume ${label}`}
                onClick={() => act(() => resumeDownload({ id: item.id }).unwrap())}
              >
                {item.state === 'error' ? 'Try again' : 'Resume'}
              </Button>
            )}
            {item.state !== 'verifying' && (
              <Button
                variant="outline"
                size="xs"
                aria-label={`Cancel ${label}`}
                onClick={() => act(() => cancelDownload({ id: item.id }).unwrap())}
              >
                Cancel
              </Button>
            )}
          </>
        )}
      </span>

      {shortBytes > 0 && !installed && !item && (
        <p role="alert" className="basis-full text-xs text-destructive">
          Not enough free space: about {formatSize(shortBytes)} more is needed.
        </p>
      )}
      {confirming && (
        <div role="alert" className="flex basis-full flex-col gap-2 rounded-md bg-muted/50 p-3 text-sm">
          <p>
            {label} is too big for your PC. It will probably be very slow or not work at all. Download it
            anyway?
          </p>
          <div className="flex gap-2">
            <Button size="sm" onClick={download}>
              Download anyway
            </Button>
            <Button variant="outline" size="sm" onClick={() => setConfirming(false)}>
              Not now
            </Button>
          </div>
        </div>
      )}
      {problem && (
        <p role="alert" className="basis-full text-xs text-destructive">
          {problem}
        </p>
      )}
    </>
  )
}
