import { Settings } from 'lucide-react'
import { ChatList } from '@app/features/chat'
import { cn } from '@app/lib/utils'
import { useAppDispatch, useAppSelector } from '@app/store/hooks'
import { selectActiveTab, selectSidebarOpen, settingsOpened, tabSelected } from '@app/store/uiSlice'
import { settingsShortcut, sidebarId, tabs } from './tabs'

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

        {/* The chats scroll under the tabs; the gear below stays at the bottom. */}
        <div className="min-h-0 flex-1 overflow-y-auto">
          <ChatList />
        </div>

        {/* Settings is a dialog, not a page, so it's a row at the bottom rather than a tab (design decision). */}
        <button
          type="button"
          aria-haspopup="dialog"
          aria-keyshortcuts={settingsShortcut}
          onClick={() => dispatch(settingsOpened())}
          className={cn(
            'mt-1.5 flex h-[34px] items-center gap-2.5 rounded-[7px] px-2.5 text-left text-[13.5px] text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-foreground',
            focusRing
          )}
        >
          <Settings aria-hidden className="size-4" />
          Settings
        </button>
      </div>
    </div>
  )
}
