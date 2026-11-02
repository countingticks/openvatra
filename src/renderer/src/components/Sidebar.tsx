import { cn } from '@renderer/lib/utils'
import { useAppDispatch, useAppSelector } from '@renderer/store/hooks'
import { selectActiveTab, tabSelected } from '@renderer/store/uiSlice'
import { tabs, type Tab } from '@renderer/tabs'

const focusRing = 'outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring'

export function Sidebar(): React.JSX.Element {
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
    <nav
      aria-label="Main"
      className="flex w-56 shrink-0 flex-col gap-0.5 border-r border-sidebar-border bg-sidebar px-2.5 py-3 text-sidebar-foreground"
    >
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
  )
}
