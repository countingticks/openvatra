import { useEffect, useId, useRef } from 'react'
import { Cpu, Info, Server, SlidersHorizontal, X, type LucideIcon } from 'lucide-react'
import { GeneralSection } from './GeneralSection'
import { ModelsSection } from './ModelsSection'
import { Dialog, DialogClose, DialogContent, DialogTitle } from '@app/ui/dialog'
import { OverlayScroll } from '@app/ui/OverlayScroll'
import { cn } from '@app/lib/utils'
import { useAppDispatch, useAppSelector } from '@app/store/hooks'
import {
  selectSettingsOpen,
  selectSettingsSection,
  settingsClosed,
  settingsSectionSelected,
  type SettingsSection
} from '@app/store/uiSlice'

const sections: {
  id: SettingsSection
  title: string
  icon: LucideIcon
  content: () => React.JSX.Element
}[] = [
  { id: 'general', title: 'General', icon: SlidersHorizontal, content: GeneralSection },
  { id: 'models', title: 'Models', icon: Cpu, content: ModelsSection }
]

/** Sections to come, shown dimmed so it's clear where future settings will live. */
const laterSections: { title: string; icon: LucideIcon }[] = [
  { title: 'Services', icon: Server },
  { title: 'About', icon: Info }
]

const navItem = 'flex h-8 items-center gap-2 rounded-sm px-2.5 text-left text-sm'

/**
 * Settings as a dialog over the app (design decision), not a page that replaces the chat. Base UI's Dialog keeps
 * focus inside while it's open, closes on Esc or a press on the dimmed area, and returns focus to whatever opened it.
 */
export function SettingsDialog(): React.JSX.Element {
  const open = useAppSelector(selectSettingsOpen)
  const current = useAppSelector(selectSettingsSection)
  const dispatch = useAppDispatch()
  const headingId = useId()
  const body = useRef<HTMLDivElement>(null)
  const section = sections.find((candidate) => candidate.id === current) ?? sections[0]
  const Content = section.content

  // A new section starts at its top, not wherever the last one was scrolled to.
  useEffect(() => {
    if (body.current) body.current.scrollTop = 0
  }, [section.id])

  return (
    <Dialog open={open} onOpenChange={(next) => !next && dispatch(settingsClosed())}>
      <DialogContent
        showCloseButton={false}
        className="flex h-[640px] max-h-[calc(100%-48px)] w-[900px] max-w-[calc(100%-48px)] gap-0 overflow-hidden rounded-[14px] bg-popover p-0 text-popover-foreground shadow-2xl ring-border sm:max-w-[900px]"
      >
        <div className="flex w-[196px] shrink-0 flex-col gap-0.5 border-r border-border bg-sidebar px-2.5 py-4">
          <DialogTitle className="px-2.5 pb-3.5 text-[15px] font-semibold">Settings</DialogTitle>
          <nav aria-label="Settings sections" className="flex flex-col gap-0.5">
            {sections.map(({ id, title, icon: Icon }) => (
              <button
                key={id}
                type="button"
                aria-current={id === section.id ? 'page' : undefined}
                onClick={() => dispatch(settingsSectionSelected(id))}
                className={cn(navItem, id === section.id ? 'bg-accent font-medium' : 'hover:bg-accent/60')}
              >
                <Icon aria-hidden className="size-4 shrink-0" />
                {title}
              </button>
            ))}
            {laterSections.map(({ title, icon: Icon }) => (
              <button
                key={title}
                type="button"
                disabled
                className={cn(navItem, 'text-muted-foreground opacity-60')}
              >
                <Icon aria-hidden className="size-4 shrink-0" />
                <span className="flex-1">{title}</span>
                <span className="text-[11px]">Later</span>
              </button>
            ))}
          </nav>
        </div>

        <section aria-labelledby={headingId} className="flex min-w-0 flex-1 flex-col">
          <OverlayScroll
            insetTop={58}
            insetBottom={12}
            className="min-h-0 flex-1"
            viewport={{ ref: body, role: 'region', 'aria-label': 'Settings body', className: 'size-full' }}
          >
            <div className="sticky top-0 z-10 flex h-[58px] items-center justify-between bg-popover px-6">
              <h2 id={headingId} className="text-base font-semibold">
                {section.title}
              </h2>
              <DialogClose
                aria-label="Close settings"
                title="Close (Esc)"
                className="-mr-3 grid size-8 place-items-center rounded-sm text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
              >
                <X aria-hidden className="size-4" />
              </DialogClose>
            </div>
            <div className="flex flex-col px-6 pb-6">
              <Content />
            </div>
          </OverlayScroll>
        </section>
      </DialogContent>
    </Dialog>
  )
}
