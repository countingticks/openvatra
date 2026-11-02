// The app window: opened where the user left it (kept on-screen), and its position saved as it moves.
import { BrowserWindow, screen } from 'electron'
import { join } from 'path'
import icon from '../../resources/icon.png?asset'
import { windowMinSize } from '../shared/settings'
import { debounce } from './debounce'
import { log } from './logger'
import type { SettingsStore } from './settingsStore'
import { safeWindowBounds } from './windowBounds'

/** How long the window must be still before its position is saved; a drag fires many move events. */
const saveBoundsDelayMs = 500

/** `show: false` keeps the window hidden (started at login: only the tray icon appears). */
export function createMainWindow(appUrl: string, store: SettingsStore, show: boolean): BrowserWindow {
  // Displays are read now, not when the bounds were saved: monitors may have changed since.
  const bounds = safeWindowBounds(
    store.get().window,
    screen.getAllDisplays().map((display) => display.workArea),
    screen.getPrimaryDisplay().workArea
  )

  const window = new BrowserWindow({
    ...bounds,
    minWidth: windowMinSize.width,
    minHeight: windowMinSize.height,
    title: 'OpenVatra',
    show: false,
    autoHideMenuBar: true,
    icon,
    // Security baseline (AGENTS.md): the UI runs like an untrusted web page. It has no Node.js access, lives in
    // its own isolated JavaScript world, and the preload that bridges to it is sandboxed too.
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  rememberBounds(window, store)
  // Hidden or not, the page loads now, so opening it from the tray later is instant.
  if (show) window.on('ready-to-show', () => window.show())

  void window.loadURL(appUrl)
  return window
}

/**
 * Closing the window hides it; the app keeps running in the tray. Only a real quit (tray menu, Windows shutdown)
 * lets the close go through, so `isQuitting` must turn true on Electron's 'before-quit'.
 */
export function hideOnClose(window: BrowserWindow, isQuitting: () => boolean, onHidden: () => void): void {
  window.on('close', (event) => {
    if (isQuitting()) return
    event.preventDefault()
    window.hide()
    onHidden()
  })
}

function rememberBounds(window: BrowserWindow, store: SettingsStore): void {
  const saveBounds = debounce(() => {
    // Normal bounds: the size it returns to from maximized, so a maximized window doesn't save as the full screen.
    store
      .setWindowBounds(window.getNormalBounds())
      .catch((error) => log.warn('Window position could not be saved', error))
  }, saveBoundsDelayMs)

  window.on('move', saveBounds)
  window.on('resize', saveBounds)
  // Closing within the delay would lose the last move; save it now, while the window still exists.
  window.on('close', () => saveBounds.flush())
}
