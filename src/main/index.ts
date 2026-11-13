import { app, Menu, type BrowserWindow } from 'electron'
import { join } from 'path'
import { pathToFileURL } from 'url'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { ipcChannels } from '../shared/ipc'
import { defaultSettingsFile, type SettingsFile } from '../shared/settings'
import { applyStartWithWindows, wasStartedAtLogin } from './autostart'
import { createConfigClient } from './core/configClient'
import { importLegacyModels, type ImportOutcome } from './core/legacyImport'
import { createModelSettings } from './core/modelSettings'
import { createSupervisor, type Supervisor } from './core/supervisor'
import { registerIpcHandlers } from './ipc'
import { log, logsFolder, setUpLogging } from './logger'
import { applySecurityPolicy } from './security'
import { loadSettings, logLoadOutcome } from './settings'
import { createSettingsService } from './settingsService'
import { createSettingsStore } from './settingsStore'
import { applyTheme } from './theme'
import { type AppTray, createTray } from './tray'
import { devServerOrigin } from './urlPolicy'
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

// Where llama.cpp engines downloaded later live (not in userData: they are large, and Windows can rebuild them).
function enginesDir(): string {
  return join(
    process.env['LOCALAPPDATA'] ?? join(app.getPath('home'), 'AppData', 'Local'),
    'OpenVatra',
    'engines'
  )
}

/** The folder holding llama-server.exe: `<resources>/llama` installed, `resources/llama/bin` in development. */
function bundledLlamaDir(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'llama')
    : join(app.getAppPath(), 'resources', 'llama', 'bin')
}

/** The pin file: beside the exe's folder in development (it is not inside bin/), inside it once installed. */
function llamaManifestPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'llama', 'llama.json')
    : join(app.getAppPath(), 'resources', 'llama', 'llama.json')
}

// core learns which CUDA build is pinned from the same llama.json the bundled build is checked against.
function coreExtraArgs(): string[] {
  const args = [
    '--llama-manifest',
    llamaManifestPath(),
    '--engines-dir',
    enginesDir(),
    // Core resolves the default llama-server from it when no path is chosen.
    '--llama-dir',
    bundledLlamaDir(),
    // Chats, attachments and documents: next to settings.json, so one folder holds the user's data.
    '--data-dir',
    join(app.getPath('userData'), 'data')
  ]
  // Test seam: a catalog file that may name a local server. Never reachable in an installed app.
  const file = process.env['OPENVATRA_TEST_CATALOG']
  if (!app.isPackaged && process.env['OPENVATRA_E2E'] === '1' && file) args.push('--test-catalog', file)
  // A file:// page sends no Origin, so only the dev server's origin needs allowing.
  const origin = devServerOrigin(appUrl)
  if (origin) args.push('--origin', origin)
  return args
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
async function loadSettingsAtStartup(filePath: string): Promise<SettingsFile> {
  try {
    const { settings, outcome } = await loadSettings(filePath)
    logLoadOutcome(log, filePath, outcome)
    return settings
  } catch (error) {
    // e.g. the bad file couldn't be renamed to .bak. Defaults still apply; settings never stop the app.
    log.error(`Settings could not be loaded from ${filePath}; using defaults`, error)
    return structuredClone(defaultSettingsFile)
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
    applySecurityPolicy(appUrl, () => {
      const state = core?.state()
      return state?.status === 'ready' ? state.port : undefined
    })

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
    const request = (path: string, init?: RequestInit): Promise<Response> =>
      core?.request(path, init) ?? Promise.reject(new Error('core is not running'))
    // core owns the model settings (paths, engine, arguments); main keeps the last answer to compose Settings.
    const configClient = createConfigClient(request)
    const modelSettings = createModelSettings({
      client: configClient,
      isReady: () => core?.state().status === 'ready',
      log
    })
    const settings = createSettingsService(store, modelSettings)
    const sendToWindow = (channel: string, value: unknown): void => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, value)
    }
    // Every change, wherever it came from (the UI, a file dialog, core's engine switch), reaches the window.
    settings.onChange((value) => sendToWindow(ipcChannels.settingsChanged, value))
    /** On every ready: a v6 user's values go to core once, then main reads what core has. */
    async function syncModelSettings(): Promise<void> {
      const legacy = store.get().legacyModels
      let outcome: ImportOutcome | undefined
      if (legacy) outcome = await importLegacyModels(configClient, legacy, log)
      await modelSettings
        .refresh()
        .catch((error) => log.warn('Could not read the model settings from core', error))
      // After the read, so the window goes from the old values straight to core's, never through the defaults.
      if (outcome && outcome !== 'retry-later') {
        await store
          .dropLegacyModels()
          .catch((error) =>
            log.warn('Could not remove the imported model settings from settings.json', error)
          )
      }
    }
    core = createSupervisor({
      exePath: coreExePath(),
      extraArgs: coreExtraArgs(),
      logsDir: logsFolder(),
      onState: (state) => sendToWindow(ipcChannels.coreStateChanged, state),
      onReady: () => void syncModelSettings(),
      log
    })
    // Before the window, so the UI's first request always finds a handler.
    registerIpcHandlers(
      settings,
      appUrl,
      { settingsFile: settingsPath, logsFolder: logsFolder() },
      {
        state: core.state,
        restart: core.restart
      }
    )

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
