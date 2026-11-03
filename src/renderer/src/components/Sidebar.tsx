import { cn } from '@renderer/lib/utils'
import { useAppDispatch, useAppSelector } from '@renderer/store/hooks'
import { selectActiveTab, selectSidebarOpen, tabSelected } from '@renderer/store/uiSlice'
import { sidebarId, tabs, type Tab } from '@renderer/tabs'

const focusRing = 'outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring'

export function Sidebar(): React.JSX.Element {
  const open = useAppSelector(selectSidebarOpen)
  const activeTab = useAppSelector(selectActiveTab)
  const dispatch = useAppDispatch()
  const settings = tabs.find((tab) => tab.id === 'settings')
  const modules = tabs.filter((tab) => tab.id !== 'settings')

  // Buttons, not links: switching tabs doesn't load a page. aria-current marks the open one for screen readers.
  function itemProps(tab: Tab): React.ComponentProps<'button'> {
    const current = tab.id === activeTab
    return {
      type: 'button',
      'aria-current': current ? 'page' : undefined,
      'aria-keyshortcuts': tab.shortcut,
      title: `${tab.label} (${tab.shortcut.replace('Control', 'Ctrl')})`,
      onClick: () => dispatch(tabSelected(tab.id))
    }
  }

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
        <nav aria-label="Main" className="flex flex-1 flex-col gap-0.5">
          {modules.map((tab) => (
            <button
              key={tab.id}
              {...itemProps(tab)}
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

          {/* Settings sits at the bottom, a little larger than the module tabs (design decision). */}
          {settings && (
            <button
              {...itemProps(settings)}
              className={cn(
                'mt-auto flex h-10 items-center gap-3 rounded-lg px-3 text-left text-[15px]',
                focusRing,
                settings.id === activeTab
                  ? 'bg-sidebar-accent font-medium text-sidebar-accent-foreground'
                  : 'text-muted-foreground hover:bg-sidebar-accent/60 hover:text-sidebar-foreground'
              )}
            >
              <settings.icon aria-hidden className="size-[18px]" />
              {settings.label}
            </button>
          )}
        </nav>
      </div>
    </div>
  )
}
