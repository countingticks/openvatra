import { Settings } from 'lucide-react'
import { cn } from '@renderer/lib/utils'
import { useAppDispatch, useAppSelector } from '@renderer/store/hooks'
import { selectActiveTab, selectSidebarOpen, settingsOpened, tabSelected } from '@renderer/store/uiSlice'
import { settingsShortcut, sidebarId, tabs } from '@renderer/tabs'

const focusRing = 'outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring'

export function Sidebar(): React.JSX.Element {
  const open = useAppSelector(selectSidebarOpen)
  const activeTab = useAppSelector(selectActiveTab)
  const dispatch = useAppDispatch()

  return (
    // The panel slides closed (styles/globals.css). Closed, it's inert: out of the Tab order and hidden from
    // screen readers, not just invisible. The inner column keeps its width so nothing reflows while it moves.
    <div
      id={sidebarId}
      data-state={open ? 'open' : 'closed'}
      inert={!open}
      className="sidebar-panel w-56 shrink-0 overflow-hidden border-r border-sidebar-border bg-sidebar text-sidebar-foreground data-[state=closed]:w-0 data-[state=closed]:border-r-0"
    >
      {/* Starts 52px down: the title bar (40px) lies over the top of the sidebar. */}
      <div className="flex h-full w-56 flex-col gap-0.5 px-2.5 pt-[52px] pb-3">
        <nav aria-label="Main" className="flex flex-col gap-0.5">
          {/* Buttons, not links: switching tabs doesn't load a page. aria-current marks the open one. */}
          {tabs.map((tab) => (
            <button
              key={tab.id}
              type="button"
              aria-current={tab.id === activeTab ? 'page' : undefined}
              aria-keyshortcuts={tab.shortcut}
              title={`${tab.label} (${tab.shortcut.replace('Control', 'Ctrl')})`}
              onClick={() => dispatch(tabSelected(tab.id))}
              className={cn(
                'flex h-8 items-center gap-2.5 rounded-sm px-2.5 text-left',
                focusRing,
                tab.id === activeTab
                  ? 'bg-sidebar-accent font-medium text-sidebar-accent-foreground'
                  : 'text-muted-foreground hover:bg-sidebar-accent/60 hover:text-sidebar-foreground'
              )}
            >
              <tab.icon aria-hidden className="size-4" />
              {tab.label}
            </button>
          ))}
        </nav>

        {/* Settings is a dialog, not a page, so it's a gear at the bottom rather than a tab (design decision). */}
        <button
          type="button"
          aria-label="Settings"
          aria-haspopup="dialog"
          aria-keyshortcuts={settingsShortcut}
          title="Settings (Ctrl+,)"
          onClick={() => dispatch(settingsOpened())}
          className={cn(
            'mt-auto grid size-8 place-items-center rounded-sm text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-foreground',
            focusRing
          )}
        >
          <Settings aria-hidden className="size-[18px]" />
        </button>
      </div>
    </div>
  )
}
