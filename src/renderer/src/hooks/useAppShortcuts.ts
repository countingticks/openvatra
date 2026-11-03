// App-wide shortcuts from the menu: Ctrl+, (Settings), Ctrl+W (close window), Ctrl+Q (quit),
// Alt+← / Alt+→ (back / forward).
import { useEffect } from 'react'
import { useAppDispatch } from '@renderer/store/hooks'
import { tabSelected, wentBack, wentForward } from '@renderer/store/uiSlice'

export function useAppShortcuts(): void {
  const dispatch = useAppDispatch()

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if (event.shiftKey || event.metaKey) return

      if (event.altKey && !event.ctrlKey) {
        if (event.key === 'ArrowLeft') dispatch(wentBack())
        else if (event.key === 'ArrowRight') dispatch(wentForward())
        else return
        event.preventDefault()
        return
      }

      if (!event.ctrlKey || event.altKey) return
      const key = event.key.toLowerCase()
      if (key === ',') dispatch(tabSelected('settings'))
      else if (key === 'w') void window.api.appWindow.close().catch((error) => console.error(error))
      else if (key === 'q') void window.api.app.quit().catch((error) => console.error(error))
      else return
      event.preventDefault()
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [dispatch])
}
