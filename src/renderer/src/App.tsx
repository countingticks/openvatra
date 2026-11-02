import { useEffect, useRef } from 'react'
import { PanelLeft } from 'lucide-react'
import { ErrorBoundary } from '@renderer/components/ErrorBoundary'
import { Sidebar } from '@renderer/components/Sidebar'
import { TabView } from '@renderer/components/TabView'
import { useSidebarShortcut } from '@renderer/hooks/useSidebarShortcut'
import { useTabShortcuts } from '@renderer/hooks/useTabShortcuts'
import { useAppDispatch, useAppSelector } from '@renderer/store/hooks'
import { selectActiveTab, selectSidebarOpen, sidebarToggled } from '@renderer/store/uiSlice'
import { sidebarId, sidebarShortcut } from '@renderer/tabs'

export function App(): React.JSX.Element {
  useTabShortcuts()
  useSidebarShortcut()
  const dispatch = useAppDispatch()
  const sidebarOpen = useAppSelector(selectSidebarOpen)
  const activeTab = useAppSelector(selectActiveTab)
  const openButton = useRef<HTMLButtonElement>(null)
  const closeButton = useRef<HTMLButtonElement>(null)

  // The control that was used disappears, so focus would fall back to the page and keyboard users would lose
  // their place. Hand it to the button that does the opposite, but only if focus was in what's being hidden.
  useEffect(() => {
    const focused = document.activeElement
    if (!sidebarOpen && document.getElementById(sidebarId)?.contains(focused)) openButton.current?.focus()
    if (sidebarOpen && focused === openButton.current) closeButton.current?.focus()
  }, [sidebarOpen])

  return (
    <div className="flex h-full">
      <Sidebar closeButtonRef={closeButton} />
      <main className="relative min-w-0 flex-1">
        <button
          ref={openButton}
          type="button"
          aria-label="Open sidebar"
          aria-expanded={sidebarOpen}
          aria-controls={sidebarId}
          aria-keyshortcuts={sidebarShortcut}
          title="Open sidebar (Ctrl+B)"
          data-state={sidebarOpen ? 'hidden' : 'shown'}
          inert={sidebarOpen}
          onClick={() => dispatch(sidebarToggled())}
          className="sidebar-opener absolute top-3 left-3 z-10 grid size-8 place-items-center rounded-sm text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
        >
          <PanelLeft aria-hidden className="size-[18px]" />
        </button>
        {/* Keyed by tab: switching tabs starts a fresh boundary, so a broken page doesn't follow you around. */}
        <ErrorBoundary key={activeTab}>
          <TabView />
        </ErrorBoundary>
      </main>
    </div>
  )
}
