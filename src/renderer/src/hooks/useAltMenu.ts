// Alt opens the app menu, as in any Windows app: Alt pressed and released on its own opens the ≡ list, and
// Alt plus a menu's first letter opens that menu (Alt+F → File). Alt+← / Alt+→ are left for Back / Forward.
import { useEffect, useRef } from 'react'

export type MenuName = 'File' | 'Edit' | 'View' | 'Go' | 'Help'

const accessKeys: Record<string, MenuName> = { f: 'File', e: 'Edit', v: 'View', g: 'Go', h: 'Help' }

/** Calls `open()` for Alt on its own, `open('File')` for Alt+F, and so on. */
export function useAltMenu(open: (menu?: MenuName) => void): void {
  // Latest callback without re-subscribing the listeners on every render.
  const openRef = useRef(open)
  useEffect(() => {
    openRef.current = open
  })

  useEffect(() => {
    // Alt counts "on its own" only if nothing else was pressed or clicked between its press and release.
    let altAlone = false

    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === 'Alt') {
        altAlone = !event.repeat || altAlone
        return
      }
      altAlone = false
      if (!event.altKey || event.ctrlKey || event.shiftKey || event.metaKey) return
      const menu = accessKeys[event.key.toLowerCase()]
      if (!menu) return
      event.preventDefault()
      openRef.current(menu)
    }

    function onKeyUp(event: KeyboardEvent): void {
      if (event.key !== 'Alt') return
      if (altAlone) {
        event.preventDefault()
        openRef.current()
      }
      altAlone = false
    }

    const interrupt = (): void => {
      altAlone = false
    }

    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    window.addEventListener('mousedown', interrupt)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
      window.removeEventListener('mousedown', interrupt)
    }
  }, [])
}
