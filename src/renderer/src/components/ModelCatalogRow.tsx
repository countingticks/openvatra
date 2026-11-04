import { useState } from 'react'
import { AlertTriangle, CheckCircle2, Gauge } from 'lucide-react'
import { DownloadControls } from '@renderer/components/DownloadControls'
import { Button } from '@renderer/components/ui/button'
import { failureReason, formatSize } from '@renderer/lib/modelText'
import { fitText } from '@renderer/lib/setupText'
import type { CatalogEntry, DownloadItem } from '../../../shared/setup'

const fitIcons = { fits: CheckCircle2, slower: Gauge, tooBig: AlertTriangle }

interface ModelCatalogRowProps {
  entry: CatalogEntry
  recommended: boolean
  /** This entry's place in the download queue, if it has one. */
  item: DownloadItem | undefined
  /** Called after a removal, so the list can read the catalog again. */
  onRemoved: () => void
}

/** One catalog model: what it is, whether it fits, and the one thing you can do with it right now. */
export function ModelCatalogRow({
  entry,
  recommended,
  item,
  onRemoved
}: ModelCatalogRowProps): React.JSX.Element {
  // Both risky actions ask first, and the question says what it costs.
  const [asking, setAsking] = useState<'remove' | 'tooBig' | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const FitIcon = fitIcons[entry.fit]
  const short = entry.diskShortBytes > 0

  const act = (action: () => Promise<unknown>, after?: () => void): void => {
    setProblem(null)
    setAsking(null)
    action().then(after, (error) => setProblem(failureReason(error)))
  }
  const download = (): void => act(() => window.api.setup.download(entry.id))

  return (
    <li className="flex flex-col gap-2 border-b border-border px-3 py-3 last:border-b-0">
      <div className="flex items-start justify-between gap-4">
        <div className="flex min-w-0 flex-col gap-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium">{entry.name}</span>
            {recommended && (
              <span className="rounded-sm bg-primary/15 px-1.5 py-0.5 text-[11px] font-medium">
                Recommended
              </span>
            )}
            {entry.tags.map((tag) => (
              <span key={tag} className="rounded-sm bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">
                {tag}
              </span>
            ))}
          </div>
          <span className="text-[12.5px] text-muted-foreground">{entry.summary}</span>
          <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <FitIcon aria-hidden className="size-3.5" />
            {formatSize(entry.sizeBytes)} · {fitText(entry.fit)}
          </span>
        </div>

        {entry.installed ? (
          <div className="flex shrink-0 items-center gap-2">
            <span className="text-sm text-muted-foreground">Installed</span>
            <Button
              variant="outline"
              size="sm"
              aria-label={`Remove ${entry.name}`}
              onClick={() => setAsking('remove')}
            >
              Remove
            </Button>
          </div>
        ) : !item ? (
          <Button
            size="sm"
            className="shrink-0"
            aria-label={`Download ${entry.name}`}
            disabled={short}
            onClick={() => (entry.fit === 'tooBig' ? setAsking('tooBig') : download())}
          >
            Download
          </Button>
        ) : null}
      </div>

      {!entry.installed && item && (
        <DownloadControls
          item={item}
          disabled={short}
          onDownload={download}
          onCancel={() => act(() => window.api.setup.cancel(entry.id))}
          onResume={() => act(() => window.api.setup.resume(entry.id))}
        />
      )}

      {short && !entry.installed && !item && (
        <p role="alert" className="text-sm text-destructive">
          Not enough free space: about {formatSize(entry.diskShortBytes)} more is needed.
        </p>
      )}

      {asking === 'tooBig' && (
        <div role="alert" className="flex flex-col gap-2 rounded-md bg-muted/50 p-3 text-sm">
          <p>
            {entry.name} is too big for your PC. It will probably be very slow or not work at all. Download it
            anyway?
          </p>
          <div className="flex gap-2">
            <Button size="sm" onClick={download}>
              Download anyway
            </Button>
            <Button variant="outline" size="sm" onClick={() => setAsking(null)}>
              Not now
            </Button>
          </div>
        </div>
      )}
      {asking === 'remove' && (
        <div role="alert" className="flex flex-col gap-2 rounded-md bg-muted/50 p-3 text-sm">
          <p>
            Remove {entry.name}? This frees about {formatSize(entry.sizeBytes)}. It goes to the Recycle Bin,
            and you can download it again later.
          </p>
          <div className="flex gap-2">
            <Button
              variant="destructive"
              size="sm"
              onClick={() => act(() => window.api.setup.remove(entry.id), onRemoved)}
            >
              Remove it
            </Button>
            <Button variant="outline" size="sm" onClick={() => setAsking(null)}>
              Keep it
            </Button>
          </div>
        </div>
      )}

      {problem && (
        <p role="alert" className="text-sm text-destructive">
          {problem}
        </p>
      )}
    </li>
  )
}
