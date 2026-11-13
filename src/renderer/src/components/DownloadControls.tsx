import { Button } from '@renderer/components/ui/button'
import { progressText } from '@renderer/lib/setupText'
import type { DownloadItem } from '@renderer/core/types'

/** Download / progress + Cancel / Resume for one catalog model; shared by the welcome card and the Models dialog. */
interface DownloadControlsProps {
  item: DownloadItem | undefined
  disabled: boolean
  onDownload: () => void
  onCancel: () => void
  onResume: () => void
}

export function DownloadControls({
  item,
  disabled,
  onDownload,
  onCancel,
  onResume
}: DownloadControlsProps): React.JSX.Element {
  if (!item) {
    return (
      <Button onClick={onDownload} disabled={disabled}>
        Download
      </Button>
    )
  }
  if (item.state === 'done') return <p role="status">Almost ready…</p>

  const stuck = item.state === 'paused' || item.state === 'error'
  const percent = item.total > 0 ? Math.round((item.bytes / item.total) * 100) : 0
  return (
    <div className="flex w-full flex-col items-center gap-2">
      {!stuck && (
        <progress
          aria-label="Download progress"
          className="h-2 w-full accent-primary"
          max={100}
          value={percent}
        />
      )}
      <p className="text-sm" role="status">
        {item.state === 'paused' && `Paused · ${progressText(item)}`}
        {item.state === 'error' && `The download stopped: ${item.error ?? 'something went wrong'}`}
        {item.state === 'queued' && 'Waiting to start…'}
        {item.state === 'verifying' && 'Checking the download…'}
        {item.state === 'downloading' && progressText(item)}
      </p>
      <div className="flex gap-2">
        {stuck && <Button onClick={onResume}>{item.state === 'error' ? 'Try again' : 'Resume'}</Button>}
        {item.state !== 'verifying' && (
          <Button variant="outline" onClick={onCancel}>
            Cancel
          </Button>
        )}
      </div>
    </div>
  )
}
