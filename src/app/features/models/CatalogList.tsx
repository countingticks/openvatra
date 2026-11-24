import { ModelCatalogRow } from './ModelCatalogRow'
import { useSetup } from './useSetup'
import { formatSize } from './modelText'

/** The models we offer, with their downloads. Its own component so the catalog is read only while its tab is open. */
export function CatalogList(): React.JSX.Element {
  const { catalog, downloads } = useSetup()
  if (!catalog) return <p role="status">Loading the list…</p>
  return (
    <div className="flex flex-col gap-3">
      {catalog.diskFreeBytes !== null && (
        <p className="text-xs text-muted-foreground">
          {formatSize(catalog.diskFreeBytes)} free where models are saved.
        </p>
      )}
      <ul className="flex flex-col rounded-lg border border-border">
        {catalog.entries.map((entry) => (
          <ModelCatalogRow
            key={entry.id}
            entry={entry}
            recommended={entry.id === catalog.recommended}
            item={downloads.find((download) => download.id === entry.id)}
          />
        ))}
      </ul>
    </div>
  )
}
