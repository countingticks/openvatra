import { useId, useRef } from 'react'
import { CatalogList, InstalledList, useModels } from '@app/features/models'
import { cn } from '@app/lib/utils'
import { useAppDispatch, useAppSelector } from '@app/store/hooks'
import { modelsTabSelected, selectModelsTab, type ModelsTab } from '@app/store/uiSlice'

const tabs: { id: ModelsTab; label: string }[] = [
  { id: 'installed', label: 'Installed' },
  { id: 'more', label: 'Get more models' }
]

/** Installed models and the ones to download, as two tabs; only the open tab's panel is rendered (and reads core). */
export function ModelsTabs(): React.JSX.Element {
  const current = useAppSelector(selectModelsTab)
  const dispatch = useAppDispatch()
  const count = useModels().length
  const baseId = useId()
  const buttons = useRef<Partial<Record<ModelsTab, HTMLButtonElement | null>>>({})

  function select(next: ModelsTab): void {
    dispatch(modelsTabSelected(next))
    buttons.current[next]?.focus()
  }

  function onKeyDown(event: React.KeyboardEvent): void {
    const index = tabs.findIndex((tab) => tab.id === current)
    const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0
    if (step === 0) return
    event.preventDefault()
    select(tabs[(index + step + tabs.length) % tabs.length].id)
  }

  return (
    <div className="flex flex-col">
      <div role="tablist" aria-label="Models" className="flex gap-5 border-b border-border">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            ref={(element) => {
              buttons.current[tab.id] = element
            }}
            type="button"
            role="tab"
            id={`${baseId}-${tab.id}`}
            aria-selected={tab.id === current}
            aria-controls={`${baseId}-${tab.id}-panel`}
            tabIndex={tab.id === current ? 0 : -1}
            onClick={() => select(tab.id)}
            onKeyDown={onKeyDown}
            className={cn(
              'relative flex h-9 items-center gap-1.5 text-[13px] outline-none after:absolute after:inset-x-0 after:-bottom-px after:h-0.5 focus-visible:ring-2 focus-visible:ring-ring',
              tab.id === current
                ? 'font-medium text-foreground after:bg-foreground'
                : 'text-muted-foreground hover:text-foreground'
            )}
          >
            {tab.label}
            {/* Whitespace between flex items draws nothing, but keeps the accessible name "Installed 3". */}
            {tab.id === 'installed' && ' '}
            {tab.id === 'installed' && (
              <span className="rounded-full bg-accent px-1.5 py-px text-[11px] font-normal text-foreground">
                {count}
              </span>
            )}
          </button>
        ))}
      </div>
      <div
        role="tabpanel"
        id={`${baseId}-${current}-panel`}
        aria-labelledby={`${baseId}-${current}`}
        className="pt-4"
      >
        {current === 'installed' ? <InstalledList /> : <CatalogList />}
      </div>
    </div>
  )
}
