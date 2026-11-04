import { useState } from 'react'
import { Ember } from '@renderer/components/Ember'
import { Button } from '@renderer/components/ui/button'
import { useSetup } from '@renderer/hooks/useSetup'
import { failureReason, formatSize } from '@renderer/lib/modelText'
import { fitText, hardwareLine, progressText } from '@renderer/lib/setupText'
import { useAppDispatch, useAppSelector } from '@renderer/store/hooks'
import { selectSettings, settingsReplaced } from '@renderer/store/settingsSlice'
import type { DownloadItem } from '../../../shared/setup'

interface WelcomeCardProps {
  /** Opens the Models dialog; the link is left out until that dialog exists. */
  onSeeOtherModels?: () => void
}

/** Shown in the Chat tab while there are no chat models: one recommendation, one button. */
export function WelcomeCard({ onSeeOtherModels }: WelcomeCardProps): React.JSX.Element | null {
  const { hardware, catalog, downloads } = useSetup()
  const modelsDir = useAppSelector(selectSettings).models.modelsDir
  const dispatch = useAppDispatch()
  const [problem, setProblem] = useState<string | null>(null)

  if (!hardware || !catalog) return null
  const entry = catalog.entries.find((candidate) => candidate.id === catalog.recommended)
  const item = entry && downloads.find((download) => download.id === entry.id)

  // Rejections carry core's short reason ("not enough space"…); show it instead of failing silently.
  const act = (action: () => Promise<unknown>): void => {
    setProblem(null)
    action().catch((error) => setProblem(failureReason(error)))
  }
  const change = (): void =>
    act(async () => {
      const saved = await window.api.files.pick('modelsDir')
      if (saved) dispatch(settingsReplaced(saved))
    })

  return (
    <section
      aria-labelledby="welcome-title"
      className="flex w-full max-w-md flex-col items-center gap-4 rounded-xl border border-border bg-card p-6 text-center"
    >
      <Ember state="idle" scale={3} />
      <h1 id="welcome-title" className="text-xl font-semibold tracking-tight">
        Let&apos;s get you a model
      </h1>
      <p className="text-sm text-muted-foreground">{hardwareLine(hardware)}</p>

      {entry ? (
        <>
          <div className="flex w-full flex-col gap-1 rounded-lg bg-muted/50 p-3">
            <span className="font-medium">{entry.name}</span>
            <span className="text-sm text-muted-foreground">{entry.summary}</span>
            <span className="text-xs text-muted-foreground">
              {formatSize(entry.sizeBytes)} · {fitText(entry.fit)}
            </span>
          </div>
          <DownloadControls
            item={item}
            disabled={entry.diskShortBytes > 0}
            onDownload={() => act(() => window.api.setup.download(entry.id))}
            onCancel={() => act(() => window.api.setup.cancel(entry.id))}
            onResume={() => act(() => window.api.setup.resume(entry.id))}
          />
          {entry.diskShortBytes > 0 && (
            <p role="alert" className="text-sm text-destructive">
              Not enough free space: about {formatSize(entry.diskShortBytes)} more is needed.
            </p>
          )}
        </>
      ) : (
        <p className="text-sm">
          None of the models we offer will run well on this PC. You can still look at them all and pick one.
        </p>
      )}

      {problem && (
        <p role="alert" className="text-sm text-destructive">
          {problem}
        </p>
      )}

      <p className="text-xs text-muted-foreground">
        Models are saved in {modelsDir ?? 'the OpenVatra\\Models folder in your user folder'}.{' '}
        <Button variant="link" size="xs" className="h-auto p-0 text-xs" onClick={change}>
          Change…
        </Button>
      </p>
      {onSeeOtherModels && (
        <Button variant="ghost" size="sm" onClick={onSeeOtherModels}>
          See other models
        </Button>
      )}
    </section>
  )
}

interface DownloadControlsProps {
  item: DownloadItem | undefined
  disabled: boolean
  onDownload: () => void
  onCancel: () => void
  onResume: () => void
}

function DownloadControls({
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
