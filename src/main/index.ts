import { app, BrowserWindow } from 'electron'
import { join } from 'path'
import { pathToFileURL } from 'url'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { log, setUpLogging } from './logger'
import { applySecurityPolicy } from './security'
import { loadSettings, logLoadOutcome } from './settings'

// The only URL the app window may show: the dev server while developing, the bundled index.html otherwise.
const appUrl =
  is.dev && process.env['ELECTRON_RENDERER_URL']
    ? process.env['ELECTRON_RENDERER_URL']
    : pathToFileURL(join(__dirname, '../renderer/index.html')).href

let mainWindow: BrowserWindow | null = null

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 560,
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

  mainWindow.on('ready-to-show', () => mainWindow?.show())
  mainWindow.on('closed', () => (mainWindow = null))

  void mainWindow.loadURL(appUrl)
}

/** Brings the existing window to the front (used when OpenVatra is started a second time). */
function focusMainWindow(): void {
  if (!mainWindow) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
}

/** Settings are read before the first window, which will need them (theme, size). */
async function loadSettingsAtStartup(): Promise<void> {
  const filePath = join(app.getPath('userData'), 'settings.json')
  try {
    const { outcome } = await loadSettings(filePath)
    logLoadOutcome(log, filePath, outcome)
  } catch (error) {
    // e.g. the bad file couldn't be renamed to .bak. Defaults still apply; settings never stop the app.
    log.error(`Settings could not be loaded from ${filePath}; using defaults`, error)
  }
}

function start(): void {
  setUpLogging()
  log.info(`OpenVatra ${app.getVersion()} starting`)

  app.on('second-instance', focusMainWindow)

  app.whenReady().then(async () => {
    electronApp.setAppUserModelId('com.countingticks.openvatra')

    // Before any window exists, so every window and web view is guarded from its first moment.
    applySecurityPolicy(appUrl)

    // Development: F12 toggles DevTools. Production: blocks Ctrl+R reloads.
    // see https://github.com/alex8088/electron-toolkit/tree/master/packages/utils
    app.on('browser-window-created', (_, window) => {
      optimizer.watchWindowShortcuts(window)
    })

    await loadSettingsAtStartup()
    createWindow()
  })

  app.on('window-all-closed', () => app.quit())
}

// Entry point. One OpenVatra at a time: a second copy would fight the first over settings and the local AI
// services' ports, so a second launch hands over to the first ('second-instance' above) and exits right away.
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  start()
}
