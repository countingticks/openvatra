import { useEffect, useRef } from 'react'
import { ErrorBoundary } from '@renderer/components/ErrorBoundary'
import { Sidebar } from '@renderer/components/Sidebar'
import { TabView } from '@renderer/components/TabView'
import { TitleBar } from '@renderer/components/TitleBar'
import { useSidebarShortcut } from '@renderer/hooks/useSidebarShortcut'
import { useTabShortcuts } from '@renderer/hooks/useTabShortcuts'
import { useAppSelector } from '@renderer/store/hooks'
import { selectActiveTab, selectSidebarOpen } from '@renderer/store/uiSlice'
import { sidebarId } from '@renderer/tabs'

export function App(): React.JSX.Element {
  useTabShortcuts()
  useSidebarShortcut()
  const sidebarOpen = useAppSelector(selectSidebarOpen)
  const activeTab = useAppSelector(selectActiveTab)
  const sidebarToggle = useRef<HTMLButtonElement>(null)

  // Ctrl+B can hide the sidebar while focus is on one of its tabs; focus would then fall back to the page and
  // keyboard users would lose their place. Hand it to the sidebar toggle, which is always visible.
  useEffect(() => {
    if (!sidebarOpen && document.getElementById(sidebarId)?.contains(document.activeElement)) {
      sidebarToggle.current?.focus()
    }
  }, [sidebarOpen])

  return (
    <div className="relative flex h-full">
      <TitleBar toggleRef={sidebarToggle} />
      <Sidebar />
      <main className="relative min-w-0 flex-1">
        {/* Keyed by tab: switching tabs starts a fresh boundary, so a broken page doesn't follow you around. */}
        <ErrorBoundary key={activeTab}>
          <TabView />
        </ErrorBoundary>
      </main>
    </div>
  )
}
