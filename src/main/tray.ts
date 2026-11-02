// The tray icon: the way back to a hidden window, and the way to really quit.
import { Menu, nativeTheme, Notification, Tray } from 'electron'
import appIcon from '../../resources/icon.png?asset'
// Electron loads the @2x file next to each of these by itself on high-DPI screens.
import iconForDarkTaskbar from '../../resources/tray-dark.png?asset'
import iconForLightTaskbar from '../../resources/tray-light.png?asset'
import { readTaskbarIsLight } from './taskbarTheme'

export interface AppTray {
  /** Shows a Windows notification; clicking it opens the window. */
  notify(title: string, body: string): void
}

// Module level on purpose: a tray that gets garbage-collected vanishes from the taskbar.
let tray: Tray | null = null

export function createTray(actions: { open: () => void; quit: () => void }): AppTray {
  tray = new Tray(iconForDarkTaskbar)
  tray.setToolTip('OpenVatra')
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Open OpenVatra', click: actions.open },
      { type: 'separator' },
      { label: 'Quit OpenVatra', click: actions.quit }
    ])
  )
  // Left-click opens, like most Windows tray apps; right-click shows the menu.
  tray.on('click', actions.open)

  const matchTaskbar = (): void => {
    void readTaskbarIsLight().then((light) => {
      if (tray && !tray.isDestroyed()) tray.setImage(light ? iconForLightTaskbar : iconForDarkTaskbar)
    })
  }
  matchTaskbar()
  // Fires when Windows' colors change; the taskbar may have changed with them.
  nativeTheme.on('updated', matchTaskbar)

  return {
    // A real toast, not tray.displayBalloon(): on Windows 11 the legacy balloon never appeared, while
    // Notification did (checked against Windows' notification database).
    notify: (title, body) => {
      const notification = new Notification({ title, body, icon: appIcon })
      notification.on('click', actions.open)
      notification.show()
    }
  }
}
