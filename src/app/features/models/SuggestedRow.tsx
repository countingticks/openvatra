import { useState } from 'react'
import { DownloadLine } from './DownloadLine'
import { Button } from '@app/ui/button'
import {
  useCancelDownloadMutation,
  usePauseDownloadMutation,
  useResumeDownloadMutation,
  useStartDownloadMutation
} from '@app/core/generated'
import { failureReason, fitLook, fitWords, formatSize, softButton } from './modelText'
import type { DownloadItem } from '@app/core/types'
import type { CatalogEntry } from './catalogView'

interface SuggestedRowProps {
  entry: CatalogEntry
  recommended: boolean
  /** This entry's place in the download queue, if it has one. */
  item: DownloadItem | undefined
}

const capitalised = (tag: string): string => tag.charAt(0).toUpperCase() + tag.slice(1)

/** One suggested model on one line: name, tags, fit and size, and the one thing you can do with it right now. */
export function SuggestedRow({ entry, recommended, item }: SuggestedRowProps): React.JSX.Element {
  const [confirming, setConfirming] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const look = fitLook[entry.fit]
  const short = entry.diskShortBytes > 0
  const installed = entry.installed || item?.state === 'done'

  const [startDownload] = useStartDownloadMutation()
  const [pauseDownload] = usePauseDownloadMutation()
  const [resumeDownload] = useResumeDownloadMutation()
  const [cancelDownload] = useCancelDownloadMutation()

  const act = (action: () => Promise<unknown>): void => {
    setProblem(null)
    setConfirming(false)
    action().catch((error: unknown) => setProblem(failureReason(error)))
  }
  const download = (): void => act(() => startDownload({ startDownload: { catalogId: entry.id } }).unwrap())

  return (
    <li className="flex flex-col gap-1 border-b border-border px-3 py-2 last:border-b-0">
      <div className="flex min-h-8 items-center gap-2 text-[13px]">
        <span className="min-w-0 truncate font-medium">{entry.name}</span>
        {recommended && (
          <span className="shrink-0 rounded-sm bg-soft px-1.5 py-0.5 text-[11px] font-medium text-soft-foreground">
            Recommended
          </span>
        )}
        {entry.tags
          .filter((tag) => tag !== 'chat')
          .map((tag) => (
            <span
              key={tag}
              className="shrink-0 rounded-sm bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground"
            >
              {capitalised(tag)}
            </span>
          ))}
        <span className="flex-1" />
        <span className={`flex shrink-0 items-center gap-1 text-xs font-medium ${look.colour}`}>
          <look.icon aria-hidden className="size-3.5" />
          {fitWords(entry.fit)}
        </span>
        <span className="w-14 shrink-0 text-right text-xs text-muted-foreground">
          {formatSize(entry.sizeBytes)}
        </span>
        <span className="flex w-24 shrink-0 justify-end">
          {installed ? (
            <span className="text-xs text-muted-foreground">Installed</span>
          ) : !item ? (
            <Button
              size="sm"
              variant={entry.fit === 'tooBig' ? 'outline' : 'default'}
              className={entry.fit === 'tooBig' ? undefined : softButton}
              aria-label={`Download ${entry.name}`}
              disabled={short}
              onClick={() => (entry.fit === 'tooBig' ? setConfirming(true) : download())}
            >
              Download
            </Button>
          ) : null}
        </span>
      </div>

      {!installed && item && (
        <DownloadLine
          item={item}
          name={entry.name}
          onPause={() => act(() => pauseDownload({ id: entry.id }).unwrap())}
          onResume={() => act(() => resumeDownload({ id: entry.id }).unwrap())}
          onCancel={() => act(() => cancelDownload({ id: entry.id }).unwrap())}
        />
      )}

      {short && !installed && !item && (
        <p role="alert" className="pb-1 text-xs text-destructive">
          Not enough free space: about {formatSize(entry.diskShortBytes)} more is needed.
        </p>
      )}

      {confirming && (
        <div role="alert" className="mb-1 flex flex-col gap-2 rounded-md bg-muted/50 p-3 text-sm">
          <p>
            {entry.name} is too big for your PC. It will probably be very slow or not work at all. Download it
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
        <p role="alert" className="pb-1 text-xs text-destructive">
          {problem}
        </p>
      )}
    </li>
  )
}
