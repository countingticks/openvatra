import { Button } from '@app/ui/button'
import { downloadPercent, speedProgress } from './hfText'
import type { DownloadItem } from '@app/core/types'

interface DownloadLineProps {
  item: DownloadItem
  /** The model's name, for the buttons' accessible names. */
  name: string
  onPause: () => void
  onResume: () => void
  onCancel: () => void
}

/** The second line of a row while its model downloads: the bar or the state in words, and what can be done. */
export function DownloadLine({
  item,
  name,
  onPause,
  onResume,
  onCancel
}: DownloadLineProps): React.JSX.Element {
  const { state } = item
  return (
    <div className="flex items-center gap-3 pb-1 text-xs text-muted-foreground">
      {state === 'downloading' && (
        <progress
          aria-label="Download progress"
          className="h-1.5 w-40 shrink-0 accent-primary"
          max={100}
          value={downloadPercent(item)}
        />
      )}
      <span role="status" className="min-w-0 flex-1 truncate">
        {state === 'downloading' && speedProgress(item)}
        {state === 'queued' && 'Waiting to start…'}
        {state === 'verifying' && 'Checking the download…'}
        {state === 'paused' && `Paused · ${speedProgress(item)}`}
        {state === 'error' && `The download stopped: ${item.error ?? 'something went wrong'}`}
      </span>
      {(state === 'downloading' || state === 'queued') && (
        <Button variant="outline" size="xs" aria-label={`Pause ${name}`} onClick={onPause}>
          Pause
        </Button>
      )}
      {(state === 'paused' || state === 'error') && (
        <Button variant="outline" size="xs" aria-label={`Resume ${name}`} onClick={onResume}>
          {state === 'error' ? 'Try again' : 'Resume'}
        </Button>
      )}
      {state !== 'verifying' && (
        <Button variant="outline" size="xs" aria-label={`Cancel ${name}`} onClick={onCancel}>
          Cancel
        </Button>
      )}
    </div>
  )
}
