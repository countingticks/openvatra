// App-wide shortcuts from the menu: Ctrl+N (new chat), Ctrl+, (Settings), Ctrl+W (close window), Ctrl+Q (quit),
// Alt+← / Alt+→ (back / forward).
import { useEffect } from 'react'
import { usePlatform } from '@app/platform/usePlatform'
import { useAppDispatch } from '@app/store/hooks'
import { navigated, settingsOpened, wentBack, wentForward } from '@app/store/uiSlice'

export function useAppShortcuts(): void {
  const dispatch = useAppDispatch()
  const platform = usePlatform()

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
      if (key === ',') dispatch(settingsOpened())
      else if (key === 'n') dispatch(navigated({ tab: 'chat' }))
      else if (key === 'w' && platform.window)
        void platform.window.close().catch((error) => console.error(error))
      else if (key === 'q' && platform.quit) void platform.quit().catch((error) => console.error(error))
      else return
      event.preventDefault()
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [dispatch, platform])
}
