import { useId } from 'react'
import { X } from 'lucide-react'
import { GeneralSection } from '@renderer/components/settings/GeneralSection'
import { Dialog, DialogClose, DialogContent, DialogTitle } from '@renderer/components/ui/dialog'
import { cn } from '@renderer/lib/utils'
import { useAppDispatch, useAppSelector } from '@renderer/store/hooks'
import { selectSettingsOpen, settingsClosed } from '@renderer/store/uiSlice'

/** Sections to come, shown dimmed so it's clear where future settings will live. */
const laterSections = ['Models', 'Services', 'About']

const navItem = 'flex h-8 items-center justify-between rounded-sm px-2.5 text-left text-sm'

/**
 * Settings as a dialog over the app (design decision), not a page that replaces the chat. Base UI's Dialog keeps
 * focus inside while it's open, closes on Esc or a press on the dimmed area, and returns focus to whatever opened it.
 */
export function SettingsDialog(): React.JSX.Element {
  const open = useAppSelector(selectSettingsOpen)
  const dispatch = useAppDispatch()
  const headingId = useId()

  return (
    <Dialog open={open} onOpenChange={(next) => !next && dispatch(settingsClosed())}>
      <DialogContent
        showCloseButton={false}
        className="flex h-[600px] max-h-[calc(100%-48px)] w-[760px] max-w-[calc(100%-48px)] gap-0 overflow-hidden rounded-[14px] bg-card p-0 text-card-foreground shadow-2xl ring-border sm:max-w-[760px]"
      >
        <div className="flex w-46 shrink-0 flex-col gap-0.5 border-r border-border bg-sidebar px-2.5 py-4">
          <DialogTitle className="px-2.5 pb-3.5 text-[15px] font-semibold">Settings</DialogTitle>
          <nav aria-label="Settings sections" className="flex flex-col gap-0.5">
            <button type="button" aria-current="page" className={cn(navItem, 'bg-accent font-medium')}>
              General
            </button>
            {laterSections.map((section) => (
              <button
                key={section}
                type="button"
                disabled
                className={cn(navItem, 'text-muted-foreground opacity-60')}
              >
                {section} <span className="text-[11px]">Later</span>
              </button>
            ))}
          </nav>
        </div>

        <section
          aria-labelledby={headingId}
          className="flex min-w-0 flex-1 flex-col overflow-y-auto px-6 pt-3 pb-6"
        >
          <div className="flex items-center justify-between pb-1">
            <h2 id={headingId} className="text-base font-semibold">
              General
            </h2>
            <DialogClose
              aria-label="Close settings"
              title="Close (Esc)"
              className="grid size-8 place-items-center rounded-sm text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
            >
              <X aria-hidden className="size-4" />
            </DialogClose>
          </div>
          <GeneralSection />
        </section>
      </DialogContent>
    </Dialog>
  )
}
