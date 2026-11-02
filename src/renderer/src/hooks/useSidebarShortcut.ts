// Ctrl+B opens or closes the sidebar from anywhere, as in VS Code and Claude.
import { useEffect } from 'react'
import { useAppDispatch } from '@renderer/store/hooks'
import { sidebarToggled } from '@renderer/store/uiSlice'

export function useSidebarShortcut(): void {
  const dispatch = useAppDispatch()

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if (!event.ctrlKey || event.altKey || event.shiftKey || event.metaKey) return
      // By letter, not key position, so it's Ctrl+B on any keyboard layout.
      if (event.key.toLowerCase() !== 'b') return
      event.preventDefault()
      dispatch(sidebarToggled())
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [dispatch])
}
