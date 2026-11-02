// The app's light/dark mode. One switch for everything: themeSource sets Electron's own parts (title bar,
// scrollbars) and what the page's `prefers-color-scheme` reports, which the UI follows. 'system' tracks the
// Windows apps setting live.
import { nativeTheme, type BrowserWindow } from 'electron'
import type { Settings } from '../shared/settings'

export function applyTheme(theme: Settings['theme']): void {
  nativeTheme.themeSource = theme
}

/** The page's background (the --background tokens), shown before the page paints so dark mode never flashes white. */
export function windowBackground(): string {
  return nativeTheme.shouldUseDarkColors ? '#111113' : '#FFFFFF'
}

/** Keeps the window's own background in step when the theme or the Windows mode changes. */
export function followThemeBackground(window: BrowserWindow): void {
  const update = (): void => window.setBackgroundColor(windowBackground())
  nativeTheme.on('updated', update)
  window.once('closed', () => nativeTheme.off('updated', update))
}
