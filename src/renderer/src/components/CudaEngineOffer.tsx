import { useState } from 'react'
import { DownloadControls } from '@renderer/components/DownloadControls'
import { Button } from '@renderer/components/ui/button'
import {
  useCancelDownloadMutation,
  useResumeDownloadMutation,
  useStartDownloadMutation
} from '@renderer/core/generated'
import { useCudaEngine } from '@renderer/hooks/useCudaEngine'
import { useModelSettings } from '@renderer/hooks/useModelSettings'
import { failureReason } from '@renderer/lib/modelText'
import { useAppDispatch, useAppSelector } from '@renderer/store/hooks'
import { selectSettings, settingsChanged } from '@renderer/store/settingsSlice'

// Two files of about 280 and 370 MB; round up, since sizes here are promises.
const size = 'about 700 MB'

/**
 * The faster engine for NVIDIA cards. `card` is the one-time offer in the model popover (hidden for good after *Not
 * now*); `row` is the Settings line, which stays so the choice can be undone.
 */
export function CudaEngineOffer({ variant }: { variant: 'card' | 'row' }): React.JSX.Element | null {
  const { offered, status, inUse, item } = useCudaEngine()
  const dismissed = useAppSelector(selectSettings).cudaOfferDismissed
  const dispatch = useAppDispatch()
  const [problem, setProblem] = useState<string>()
  const { update } = useModelSettings()
  const [startDownload] = useStartDownloadMutation()
  const [cancelDownload] = useCancelDownloadMutation()
  const [resumeDownload] = useResumeDownloadMutation()

  if (!offered) return null
  const card = variant === 'card'
  // Installed but switched off (after *Use the standard engine*) is not an offer; the Settings line handles it.
  if (card && (dismissed || status === 'ready') && !item) return null

  const use = (engine: 'bundled' | 'cuda'): void => {
    setProblem(undefined)
    update({ engine }).catch((error: Error) => setProblem(error.message))
  }
  const download = (): void => {
    setProblem(undefined)
    startDownload({ startDownload: { engine: 'cuda' } })
      .unwrap()
      .catch((error: unknown) => setProblem(failureReason(error)))
  }

  const stale = status === 'stale'
  const title = stale ? 'Update the faster engine' : 'Faster engine for your NVIDIA card'
  let action: React.ReactNode
  if (item) {
    action = (
      <DownloadControls
        item={item}
        disabled={false}
        onDownload={download}
        onCancel={() => void cancelDownload({ id: item.id })}
        onResume={() => void resumeDownload({ id: item.id })}
      />
    )
  } else if (inUse) {
    action = (
      <Button variant="outline" size="sm" onClick={() => use('bundled')}>
        Use the standard engine
      </Button>
    )
  } else if (status === 'ready') {
    action = (
      <Button variant="outline" size="sm" onClick={() => use('cuda')}>
        Use the faster engine
      </Button>
    )
  } else {
    action = (
      <div className="flex gap-2">
        <Button size="sm" onClick={download}>
          Download
        </Button>
        {card && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => dispatch(settingsChanged({ cudaOfferDismissed: true }))}
          >
            Not now
          </Button>
        )}
      </div>
    )
  }

  const hint = inUse
    ? 'In use. Models run faster on your graphics card.'
    : status === 'ready'
      ? 'Installed, but not in use.'
      : `${size}. Models run faster on your graphics card.`

  return (
    <section
      aria-label={title}
      className={
        card
          ? 'flex flex-col gap-2 rounded-md border border-border p-3'
          : 'flex items-center justify-between gap-5 border-b border-border py-4'
      }
    >
      <div className="flex min-w-0 flex-col gap-0.5">
        <p className="text-sm font-medium">{title}</p>
        <p className="text-[12.5px] text-muted-foreground">{hint}</p>
        {problem && (
          <p role="alert" className="text-xs text-destructive">
            {problem}
          </p>
        )}
      </div>
      {action}
    </section>
  )
}
