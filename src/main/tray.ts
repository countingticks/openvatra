// The tray icon: the way back to a hidden window, and the way to really quit.
import { Menu, nativeImage, nativeTheme, Tray } from 'electron'
import appIcon from '../../resources/icon.png?asset'
// Electron loads the @2x file next to each of these by itself on high-DPI screens.
import iconForDarkTaskbar from '../../resources/tray-dark.png?asset'
import iconForLightTaskbar from '../../resources/tray-light.png?asset'
import { readTaskbarIsLight } from './taskbarTheme'

export interface AppTray {
  /** Shows a notice from the tray icon (a notification on Windows 10/11). */
  notify(title: string, content: string): void
}

export function createTray(actions: { open: () => void; quit: () => void }): AppTray {
  const tray = new Tray(iconForDarkTaskbar)
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
      if (!tray.isDestroyed()) tray.setImage(light ? iconForLightTaskbar : iconForDarkTaskbar)
    })
  }
  matchTaskbar()
  // Fires when Windows' colors change; the taskbar may have changed with them.
  nativeTheme.on('updated', matchTaskbar)

  return {
    notify: (title, content) =>
      tray.displayBalloon({ title, content, iconType: 'custom', icon: nativeImage.createFromPath(appIcon) })
  }
}
