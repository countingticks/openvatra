// Whether the window is maximized, for the Maximize / Restore button. Asked once, then kept current by main,
// which reports every change, including ones the button didn't cause (double-click on the bar, Aero Snap).
import { useEffect, useState } from 'react'
import type { AppWindowApi } from '../../../shared/ipc'

export function useMaximized(appWindow: AppWindowApi): boolean {
  const [maximized, setMaximized] = useState(false)

  useEffect(() => {
    let current = true
    appWindow
      .isMaximized()
      .then((value) => current && setMaximized(value))
      .catch((error) => console.error('Could not read the window state', error))
    const stop = appWindow.onMaximizedChange(setMaximized)
    return () => {
      current = false
      stop()
    }
  }, [appWindow])

  return maximized
}
