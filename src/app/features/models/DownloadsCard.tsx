import { useId, useState } from 'react'
import { DownloadLine } from './DownloadLine'
import {
  useCancelDownloadMutation,
  usePauseDownloadMutation,
  useResumeDownloadMutation
} from '@app/core/generated'
import { failureReason } from './modelText'
import { useSetup } from './useSetup'
import type { DownloadItem } from '@app/core/types'
import type { CatalogView } from './catalogView'

const shown = new Set<DownloadItem['state']>(['queued', 'downloading', 'verifying', 'paused', 'error'])

/** A catalog name, `repo · quant` for a Hugging Face id (`hf:<repo>:<quant>`), else what the queue calls it. */
function displayName(item: DownloadItem, catalog: CatalogView | null): string {
  const entry = catalog?.entries.find((candidate) => candidate.id === item.id)
  if (entry) return entry.name
  if (item.id.startsWith('hf:')) {
    const last = item.id.lastIndexOf(':')
    const repo = item.id.slice(3, last)
    const quant = item.id.slice(last + 1)
    if (last > 2 && repo && quant) return `${repo} · ${quant}`
  }
  return item.name || item.id
}

function DownloadRow({ item, name }: { item: DownloadItem; name: string }): React.JSX.Element {
  const [problem, setProblem] = useState<string | null>(null)
  const [pause] = usePauseDownloadMutation()
  const [resume] = useResumeDownloadMutation()
  const [cancel] = useCancelDownloadMutation()
  const act = (action: () => Promise<unknown>): void => {
    setProblem(null)
    action().catch((error: unknown) => setProblem(failureReason(error)))
  }

  return (
    <li className="flex flex-col gap-1 text-[13px]">
      <span className="min-w-0 truncate font-medium">{name}</span>
      <DownloadLine
        item={item}
        name={name}
        onPause={() => act(() => pause({ id: item.id }).unwrap())}
        onResume={() => act(() => resume({ id: item.id }).unwrap())}
        onCancel={() => act(() => cancel({ id: item.id }).unwrap())}
      />
      {problem && (
        <p role="alert" className="text-xs text-destructive">
          {problem}
        </p>
      )}
    </li>
  )
}

/** Every download in progress except the engine's, with its controls; nothing while there is none. */
export function DownloadsCard(): React.JSX.Element | null {
  const { downloads, catalog } = useSetup()
  const headingId = useId()
  const items = downloads.filter((item) => shown.has(item.state) && item.id !== 'engine-cuda')
  if (items.length === 0) return null

  return (
    <div className="pt-4">
      <section aria-labelledby={headingId} className="flex flex-col gap-2.5 rounded-xl bg-card px-4 py-3.5">
        <h3 id={headingId} className="text-[13px] font-medium text-foreground">
          Downloading
        </h3>
        <ul className="flex flex-col gap-3">
          {items.map((item) => (
            <DownloadRow key={item.id} item={item} name={displayName(item, catalog)} />
          ))}
        </ul>
      </section>
    </div>
  )
}
