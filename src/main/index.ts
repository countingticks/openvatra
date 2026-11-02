import { app, type BrowserWindow } from 'electron'
import { join } from 'path'
import { pathToFileURL } from 'url'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { defaultSettings, type Settings } from '../shared/settings'
import { applyStartWithWindows, wasStartedAtLogin } from './autostart'
import { registerIpcHandlers } from './ipc'
import { log, setUpLogging } from './logger'
import { applySecurityPolicy } from './security'
import { loadSettings, logLoadOutcome } from './settings'
import { createSettingsStore } from './settingsStore'
import { type AppTray, createTray } from './tray'
import { createMainWindow, hideOnClose } from './window'

// The only URL the app window may show: the dev server while developing, the bundled index.html otherwise.
const appUrl =
  is.dev && process.env['ELECTRON_RENDERER_URL']
    ? process.env['ELECTRON_RENDERER_URL']
    : pathToFileURL(join(__dirname, '../renderer/index.html')).href

let mainWindow: BrowserWindow | null = null
// Module level on purpose: a tray that gets garbage-collected vanishes from the taskbar.
let tray: AppTray | null = null

// Set by 'before-quit'. Until then, closing the window only hides it to the tray.
let quitting = false

/** Brings the window back: from the tray, or when OpenVatra is started a second time. */
function focusMainWindow(): void {
  if (!mainWindow) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
}

/** Settings are read before the first window, which will need them (theme, size). */
async function loadSettingsAtStartup(filePath: string): Promise<Settings> {
  try {
    const { settings, outcome } = await loadSettings(filePath)
    logLoadOutcome(log, filePath, outcome)
    return settings
  } catch (error) {
    // e.g. the bad file couldn't be renamed to .bak. Defaults still apply; settings never stop the app.
    log.error(`Settings could not be loaded from ${filePath}; using defaults`, error)
    return structuredClone(defaultSettings)
  }
}

function start(): void {
  setUpLogging()
  log.info(`OpenVatra ${app.getVersion()} starting`)

  app.on('second-instance', focusMainWindow)
  app.on('before-quit', () => (quitting = true))

  app.whenReady().then(async () => {
    electronApp.setAppUserModelId('com.countingticks.openvatra')

    // Before any window exists, so every window and web view is guarded from its first moment.
    applySecurityPolicy(appUrl)

    // Development: F12 toggles DevTools. Production: blocks Ctrl+R reloads.
    // see https://github.com/alex8088/electron-toolkit/tree/master/packages/utils
    app.on('browser-window-created', (_, window) => {
      optimizer.watchWindowShortcuts(window)
    })

    const settingsPath = join(app.getPath('userData'), 'settings.json')
    const store = createSettingsStore(settingsPath, await loadSettingsAtStartup(settingsPath))
    // Before the window, so the UI's first request always finds a handler.
    registerIpcHandlers(store, appUrl)

    // At startup too, so the Run entry points at this install even if the app moved since it was written.
    applyStartWithWindows(store.get().startWithWindows)
    store.onChange((settings, previous) => {
      if (settings.startWithWindows !== previous.startWithWindows)
        applyStartWithWindows(settings.startWithWindows)
    })

    mainWindow = createMainWindow(appUrl, store, !wasStartedAtLogin(process.argv))
    mainWindow.on('closed', () => (mainWindow = null))

    tray = createTray({ open: focusMainWindow, quit: () => app.quit() })
    hideOnClose(
      mainWindow,
      () => quitting,
      () => {
        if (store.get().closeToTrayNoticeShown) return
        tray?.notify('OpenVatra is still running', 'Open it again or quit from the tray icon.')
        void store
          .markCloseToTrayNoticeShown()
          .catch((error) => log.warn('Close-to-tray notice flag could not be saved', error))
      }
    )

    // Electron exits without waiting for file writes, so the quit pauses until pending saves (like the window
    // position saved on close) have finished. Then exit(), not quit(): will-quit is the last step, and a second
    // quit() from inside it is ignored, which left the process running.
    app.once('will-quit', (event) => {
      event.preventDefault()
      void store.whenIdle().finally(() => app.exit())
    })
  })
}

// Entry point. One OpenVatra at a time: a second copy would fight the first over settings and the local AI
// services' ports, so a second launch hands over to the first ('second-instance' above) and exits right away.
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  start()
}
