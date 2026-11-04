import { X } from 'lucide-react'
import { ModelCatalogRow } from '@renderer/components/ModelCatalogRow'
import { Dialog, DialogClose, DialogContent, DialogTitle } from '@renderer/components/ui/dialog'
import { useSetup } from '@renderer/hooks/useSetup'
import { formatSize } from '@renderer/lib/modelText'
import { useAppDispatch, useAppSelector } from '@renderer/store/hooks'
import { modelsDialogClosed, selectModelsDialogOpen } from '@renderer/store/uiSlice'

/** The models we offer. Its own component so the catalog is read when the dialog opens, not while it is shut. */
function CatalogList(): React.JSX.Element {
  const { catalog, downloads, refreshCatalog } = useSetup()
  if (!catalog) return <p role="status">Loading the list…</p>
  return (
    <>
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
            onRemoved={refreshCatalog}
          />
        ))}
      </ul>
    </>
  )
}

/** Pick, download and remove models; opened from the welcome card, the model button and Settings. */
export function ModelsDialog(): React.JSX.Element {
  const open = useAppSelector(selectModelsDialogOpen)
  const dispatch = useAppDispatch()
  return (
    <Dialog open={open} onOpenChange={(next) => !next && dispatch(modelsDialogClosed())}>
      <DialogContent
        showCloseButton={false}
        className="flex h-[600px] max-h-[calc(100%-48px)] w-[640px] max-w-[calc(100%-48px)] flex-col gap-3 overflow-y-auto rounded-[14px] bg-card p-6 text-card-foreground shadow-2xl ring-border sm:max-w-[640px]"
      >
        <div className="flex items-center justify-between">
          <DialogTitle className="text-base font-semibold">Get more models</DialogTitle>
          <DialogClose
            aria-label="Close"
            title="Close (Esc)"
            className="-mr-2 grid size-8 place-items-center rounded-sm text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
          >
            <X aria-hidden className="size-4" />
          </DialogClose>
        </div>
        {open && <CatalogList />}
      </DialogContent>
    </Dialog>
  )
}
