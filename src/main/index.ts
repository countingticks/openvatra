import { app, Menu, shell, type BrowserWindow } from 'electron'
import { mkdir } from 'fs/promises'
import { join } from 'path'
import { pathToFileURL } from 'url'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { ipcChannels } from '../shared/ipc'
import { defaultSettings, type Settings } from '../shared/settings'
import { applyStartWithWindows, wasStartedAtLogin } from './autostart'
import { bundledLlamaDir, bundledLlamaExe } from './bundledLlama'
import { createConfigSync } from './core/configSync'
import { createModelsClient } from './core/modelsClient'
import { createSetupClient, defaultModelsDir } from './core/setupClient'
import { createSupervisor, type Supervisor } from './core/supervisor'
import { registerIpcHandlers } from './ipc'
import { log, logsFolder, setUpLogging } from './logger'
import { applySecurityPolicy } from './security'
import { loadSettings, logLoadOutcome } from './settings'
import { createSettingsStore } from './settingsStore'
import { applyTheme } from './theme'
import { type AppTray, createTray } from './tray'
import { createMainWindow, hideOnClose } from './window'

// The only URL the app window may show: the dev server while developing, the bundled index.html otherwise.
const appUrl =
  is.dev && process.env['ELECTRON_RENDERER_URL']
    ? process.env['ELECTRON_RENDERER_URL']
    : pathToFileURL(join(__dirname, '../renderer/index.html')).href

// Packaged: shipped beside app.asar (electron-builder extraResources). Development: built by `npm run build:core`.
function coreExePath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'core', 'core.exe')
    : join(app.getAppPath(), 'resources', 'core', 'core.exe')
}

// Test seam: a catalog file that may name a local server. Never reachable in an installed app.
function coreExtraArgs(): string[] {
  const file = process.env['OPENVATRA_TEST_CATALOG']
  return !app.isPackaged && process.env['OPENVATRA_E2E'] === '1' && file ? ['--test-catalog', file] : []
}

let mainWindow: BrowserWindow | null = null
let tray: AppTray | null = null
let core: Supervisor | null = null

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

    // No Electron menu: the app draws its own (≡ in the title bar), and Alt must reach it instead of revealing a
    // hidden native menu bar. Editing shortcuts (Ctrl+C/V/Z…) are handled by Chromium itself, menu or not.
    Menu.setApplicationMenu(null)

    // Development: F12 toggles DevTools. Production: blocks Ctrl+R reloads.
    // see https://github.com/alex8088/electron-toolkit/tree/master/packages/utils
    app.on('browser-window-created', (_, window) => {
      optimizer.watchWindowShortcuts(window)
    })

    const settingsPath = join(app.getPath('userData'), 'settings.json')
    const store = createSettingsStore(settingsPath, await loadSettingsAtStartup(settingsPath))
    // Created (not started) before the IPC handlers, which need it; started after the window, which never waits for
    // core. Every state change is pushed to the window (nothing to push to before it exists or after it closed).
    const llamaDir = bundledLlamaDir(app.isPackaged, process.resourcesPath, app.getAppPath())
    const userModelsDir = defaultModelsDir(app.getPath('home'))
    const configSync = createConfigSync(
      store.get,
      (path, body) => core?.post(path, body) ?? Promise.reject(),
      log,
      bundledLlamaExe(llamaDir),
      userModelsDir
    )
    store.onChange(configSync.onSettingsChange)
    const sendToWindow = (channel: string, value: unknown): void => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, value)
    }
    const models = createModelsClient({
      request: (path, init) => core?.request(path, init) ?? Promise.reject(new Error('core is not running')),
      onModels: (list) => sendToWindow(ipcChannels.coreModelsChanged, list),
      onDownloads: (items) => sendToWindow(ipcChannels.setupDownloadsChanged, items),
      log
    })
    const setup = createSetupClient({
      request: (path, init) => core?.request(path, init) ?? Promise.reject(new Error('core is not running')),
      modelsDir: () => store.get().models.modelsDir ?? userModelsDir,
      makeDir: async (path) => void (await mkdir(path, { recursive: true })),
      trash: (path) => shell.trashItem(path),
      models: models.list,
      unload: models.unload,
      log
    })
    core = createSupervisor({
      exePath: coreExePath(),
      extraArgs: coreExtraArgs(),
      logsDir: logsFolder(),
      onState: (state) => {
        // The list only means something while core is up; a new one arrives once it is ready again.
        if (state.status !== 'ready') models.stop()
        sendToWindow(ipcChannels.coreStateChanged, state)
      },
      // A fresh core knows nothing: it gets the config as soon as it is ready, and again after every restart.
      onReady: () => {
        void configSync.sync()
        models.start()
      },
      log
    })
    // Before the window, so the UI's first request always finds a handler.
    registerIpcHandlers(store, appUrl, { settingsFile: settingsPath, logsFolder: logsFolder() }, llamaDir, {
      state: core.state,
      restart: core.restart,
      list: models.list,
      load: models.load,
      unload: models.unload,
      downloads: models.downloads,
      ...setup
    })

    // At startup too, so the Run entry points at this install even if the app moved since it was written.
    applyStartWithWindows(store.get().startWithWindows)
    // Before the window, so its first frame already has the right colours.
    applyTheme(store.get().theme)
    store.onChange((settings, previous) => {
      if (settings.startWithWindows !== previous.startWithWindows)
        applyStartWithWindows(settings.startWithWindows)
      if (settings.theme !== previous.theme) applyTheme(settings.theme)
    })

    mainWindow = createMainWindow(appUrl, store, !wasStartedAtLogin(process.argv))
    mainWindow.on('closed', () => (mainWindow = null))

    core.start()

    tray = createTray({ open: focusMainWindow, quit: () => app.quit() })
    hideOnClose(
      mainWindow,
      () => !quitting && store.get().closeAction === 'tray',
      () => {
        if (store.get().closeToTrayNoticeShown) return
        tray?.notify(
          'OpenVatra is still running',
          'Open it again or quit from the tray icon. To quit when you close the window, see Settings → General.'
        )
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
      // core gets up to 8 s to shut down; the pending saves finish in the meantime.
      void Promise.all([store.whenIdle(), core?.stop()]).finally(() => app.exit())
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
