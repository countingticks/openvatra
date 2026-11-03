// Whether the window is maximized, for the Maximize / Restore button. Asked once, then kept current by main,
// which reports every change, including ones the button didn't cause (double-click on the bar, Aero Snap).
import { useEffect, useState } from 'react'

export function useMaximized(): boolean {
  const [maximized, setMaximized] = useState(false)

  useEffect(() => {
    let current = true
    window.api.appWindow
      .isMaximized()
      .then((value) => current && setMaximized(value))
      .catch((error) => console.error('Could not read the window state', error))
    const stop = window.api.appWindow.onMaximizedChange(setMaximized)
    return () => {
      current = false
      stop()
    }
  }, [])

  return maximized
}
