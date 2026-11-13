import { useId, useState } from 'react'
import { Button } from '@renderer/components/ui/button'
import { useRemoveCatalogEntryMutation } from '@renderer/core/generated'
import { useCoreState } from '@renderer/hooks/useCoreState'
import { useSetup } from '@renderer/hooks/useSetup'
import { failureReason, formatSize } from '@renderer/lib/modelText'
import type { CatalogEntry } from '../../../../shared/setup'

interface InstalledRowProps {
  entry: CatalogEntry
}

/** One downloaded model. Removing asks first, and the question says what it frees and that it can be undone. */
function InstalledRow({ entry }: InstalledRowProps): React.JSX.Element {
  const [asking, setAsking] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  // Removing reads the catalog again through the mutation's tag.
  const [removeEntry] = useRemoveCatalogEntryMutation()

  function remove(): void {
    setAsking(false)
    setProblem(null)
    removeEntry({ id: entry.id })
      .unwrap()
      .catch((error: unknown) => setProblem(failureReason(error)))
  }

  return (
    <li className="flex flex-col gap-2 border-b border-border px-3 py-2.5 last:border-b-0">
      <div className="flex items-center gap-3">
        <span className="min-w-0 flex-1 truncate">{entry.name}</span>
        <span className="shrink-0 text-xs text-muted-foreground">{formatSize(entry.sizeBytes)}</span>
        <Button
          variant="outline"
          size="sm"
          aria-label={`Remove ${entry.name}`}
          onClick={() => setAsking(true)}
        >
          Remove
        </Button>
      </div>
      {asking && (
        <div role="alert" className="flex flex-col gap-2 rounded-md bg-muted/50 p-3 text-sm">
          <p>
            Remove {entry.name}? This frees about {formatSize(entry.sizeBytes)}. It goes to the Recycle Bin,
            and you can download it again later.
          </p>
          <div className="flex gap-2">
            <Button variant="destructive" size="sm" onClick={remove}>
              Remove it
            </Button>
            <Button variant="outline" size="sm" onClick={() => setAsking(false)}>
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

/**
 * The default view's model list: the models downloaded from our list, each with Remove. Files the user put in the
 * folder themselves are not here; they appear under "Show advanced".
 */
export function InstalledModels(): React.JSX.Element {
  const { catalog } = useSetup()
  const core = useCoreState()
  const headingId = useId()
  const installed = catalog?.entries.filter((entry) => entry.installed) ?? []

  let empty: string | null = null
  if (core?.status === 'problem') empty = `Models can't be listed right now: ${core.reason}`
  else if (!catalog) empty = 'Loading your models…'
  else if (installed.length === 0) empty = 'No models yet. Use "Get more models…" to download one.'

  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-2.5 pt-4">
      <h3 id={headingId} className="text-sm font-medium">
        Installed models
      </h3>
      {empty ? (
        <p
          role={core?.status === 'problem' ? 'alert' : 'status'}
          className="rounded-lg border border-dashed border-border px-4 py-6 text-center text-[13px] text-muted-foreground"
        >
          {empty}
        </p>
      ) : (
        <ul className="flex flex-col rounded-lg border border-border">
          {installed.map((entry) => (
            <InstalledRow key={entry.id} entry={entry} />
          ))}
        </ul>
      )}
    </section>
  )
}
