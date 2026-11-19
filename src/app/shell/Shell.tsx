import { useEffect, useRef } from 'react'
import { DialogHost } from './DialogHost'
import { ErrorBoundary } from './ErrorBoundary'
import { Sidebar } from './Sidebar'
import { Routes } from './Routes'
import { TitleBar } from './TitleBar'
import { useAppShortcuts } from './useAppShortcuts'
import { useApplyMotion } from './useApplyMotion'
import { useSidebarShortcut } from './useSidebarShortcut'
import { useTabShortcuts } from './useTabShortcuts'
import { useAppSelector } from '@app/store/hooks'
import { selectActiveTab, selectSidebarOpen } from '@app/store/uiSlice'
import { sidebarId } from './tabs'

export function Shell(): React.JSX.Element {
  useTabShortcuts()
  useSidebarShortcut()
  useAppShortcuts()
  useApplyMotion()
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
          <Routes />
        </ErrorBoundary>
      </main>
      <DialogHost />
    </div>
  )
}
