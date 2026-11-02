// Ctrl+1 … Ctrl+4 switch tabs from anywhere in the window.
import { useEffect } from 'react'
import { useAppDispatch } from '@renderer/store/hooks'
import { tabSelected } from '@renderer/store/uiSlice'
import { tabs } from '@renderer/tabs'

export function useTabShortcuts(): void {
  const dispatch = useAppDispatch()

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      // Only plain Ctrl+digit: Ctrl+Shift or Ctrl+Alt combinations are left to the system and other shortcuts.
      if (!event.ctrlKey || event.altKey || event.shiftKey || event.metaKey) return
      const tab = tabs[Number(event.key) - 1]
      if (!tab) return
      event.preventDefault()
      dispatch(tabSelected(tab.id))
    }

    window.addEventListener('keydown', onKeyDown)
    // Cleanup: without it, every re-mount would add another listener and one key press would switch twice.
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [dispatch])
}
