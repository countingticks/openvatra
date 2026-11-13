// IPC handlers: main's side of the contract in src/shared/ipc.ts. Every request is treated as untrusted.
import { app, BrowserWindow, dialog, ipcMain, shell, type IpcMainInvokeEvent } from 'electron'
import { dirname, join } from 'path'
import { z } from 'zod'
import {
  appFolders,
  editCommands,
  ipcChannels,
  pickTargets,
  type AppFolder,
  type FileLocations
} from '../shared/ipc'
import type { LlamaInfo } from '../shared/ipc'
import type { CoreState, ModelInfo } from '../shared/core'
import type { Settings } from '../shared/settings'
import type { ModelsClient } from './core/modelsClient'
import type { Supervisor } from './core/supervisor'
import { log } from './logger'
import { type SettingsService, updateErrorMessage } from './settingsService'
import { isAppUrl } from './urlPolicy'

const appFolderSchema = z.enum(appFolders)
const editCommandSchema = z.enum(editCommands)
const pickTargetSchema = z.enum(pickTargets)
// Any file name is a valid id; the length cap only keeps a hostile page from sending megabytes.
const modelIdSchema = z.string().min(1).max(255)

/** The parts of the supervisor and the models client the UI may use. */
export type CoreControl = Pick<Supervisor, 'state' | 'restart'> &
  Pick<ModelsClient, 'list' | 'load' | 'unload' | 'downloads'>

export function registerIpcHandlers(
  settings: SettingsService,
  appUrl: string,
  locations: FileLocations,
  llamaInfo: () => Promise<LlamaInfo>,
  core: CoreControl
): void {
  const folders: Record<AppFolder, string> = {
    settings: dirname(locations.settingsFile),
    logs: locations.logsFolder
  }

  /** Answers only our own UI page; the navigation guards should make anything else impossible, this double-checks. */
  function assertFromApp(event: IpcMainInvokeEvent): void {
    const url = event.senderFrame?.url ?? ''
    if (!isAppUrl(url, appUrl)) {
      log.warn(`Refused an IPC request from ${url || 'an unknown frame'}`)
      throw new Error('Request refused')
    }
  }

  ipcMain.handle(ipcChannels.settingsGet, (event): Settings => {
    assertFromApp(event)
    return settings.get()
  })

  ipcMain.handle(ipcChannels.settingsUpdate, async (event, patch: unknown): Promise<Settings> => {
    assertFromApp(event)
    try {
      return await settings.update(patch)
    } catch (error) {
      // Details go to the log; the UI gets a short message (core's sentence for a model setting), not our internals.
      log.warn('Settings update rejected', error)
      // Electron sends only the message to the UI; the cause stays in main.
      throw new Error(updateErrorMessage(error), { cause: error })
    }
  })

  ipcMain.handle(ipcChannels.filesLocations, (event): FileLocations => {
    assertFromApp(event)
    return locations
  })

  /** The window that sent the request: the buttons act on their own window, never another. */
  function senderWindow(event: IpcMainInvokeEvent): BrowserWindow {
    assertFromApp(event)
    const window = BrowserWindow.fromWebContents(event.sender)
    if (!window) throw new Error('No window for this request')
    return window
  }

  ipcMain.handle(ipcChannels.windowMinimize, (event) => senderWindow(event).minimize())
  ipcMain.handle(ipcChannels.windowToggleMaximize, (event) => {
    const window = senderWindow(event)
    if (window.isMaximized()) window.unmaximize()
    else window.maximize()
  })
  // close() goes through the window's 'close' handler, so the tray / quit choice still applies.
  ipcMain.handle(ipcChannels.windowClose, (event) => senderWindow(event).close())
  ipcMain.handle(ipcChannels.windowIsMaximized, (event): boolean => senderWindow(event).isMaximized())

  // Only the six listed commands can be run: the name is looked up in an allow-list, never used as a raw method name.
  ipcMain.handle(ipcChannels.windowEdit, (event, command: unknown) => {
    const { webContents } = senderWindow(event)
    const parsed = editCommandSchema.safeParse(command)
    if (!parsed.success) {
      log.warn('Refused an unknown edit command', command)
      throw new Error('Unknown edit command')
    }
    webContents[parsed.data]()
  })

  ipcMain.handle(ipcChannels.appQuit, (event) => {
    assertFromApp(event)
    app.quit()
  })

  ipcMain.handle(ipcChannels.coreGetState, (event): CoreState => {
    assertFromApp(event)
    return core.state()
  })

  ipcMain.handle(ipcChannels.coreRestart, async (event): Promise<void> => {
    assertFromApp(event)
    log.info('core: restart requested from the UI')
    await core.restart()
  })

  // No argument: the UI cannot choose which file opens.
  ipcMain.handle(ipcChannels.coreOpenLog, async (event): Promise<void> => {
    assertFromApp(event)
    const logFile = join(locations.logsFolder, 'main.log')
    // A .log file may have no default app; then show it in Explorer instead.
    const failure = await shell.openPath(logFile)
    if (failure) {
      log.warn(`Could not open the log: ${failure}`)
      shell.showItemInFolder(logFile)
    }
  })

  ipcMain.handle(ipcChannels.coreGetModels, (event): ModelInfo[] => {
    assertFromApp(event)
    return core.list()
  })

  for (const [channel, action] of [
    [ipcChannels.coreLoad, 'load'],
    [ipcChannels.coreUnload, 'unload']
  ] as const) {
    ipcMain.handle(channel, async (event, id: unknown): Promise<void> => {
      assertFromApp(event)
      const parsed = modelIdSchema.safeParse(id)
      if (!parsed.success) throw new Error('Invalid model id')
      try {
        await core[action](parsed.data)
      } catch (error) {
        log.warn(`core: ${action} ${parsed.data} failed`, error)
        throw error // core's message is short and meant for people ("llama-server.exe not found")
      }
    })
  }

  /** Core keeps the paths now; its refusal ("not running", its own sentence) is what the window shows. */
  async function setModelPath(key: 'llamaServerPath' | 'modelsDir', path: string | null): Promise<Settings> {
    try {
      return await settings.setModelPath(key, path)
    } catch (error) {
      log.warn(`Could not set ${key}`, error)
      throw new Error(updateErrorMessage(error), { cause: error })
    }
  }

  // The UI only names what to pick; the path comes from Windows' own dialog, so it is always the user's choice.
  ipcMain.handle(ipcChannels.filesPick, async (event, target: unknown): Promise<Settings | null> => {
    const window = senderWindow(event)
    const parsed = pickTargetSchema.safeParse(target)
    if (!parsed.success) {
      log.warn('Refused to pick an unknown path', target)
      throw new Error('Unknown path')
    }
    const { models } = settings.get()
    const result =
      parsed.data === 'llamaServer'
        ? await dialog.showOpenDialog(window, {
            title: 'Choose llama-server.exe',
            defaultPath: models.llamaServerPath ?? undefined,
            filters: [{ name: 'llama-server', extensions: ['exe'] }],
            properties: ['openFile']
          })
        : await dialog.showOpenDialog(window, {
            title: 'Choose the models folder',
            defaultPath: models.modelsDir ?? undefined,
            properties: ['openDirectory']
          })
    const [path] = result.filePaths
    if (result.canceled || !path) return null
    return setModelPath(parsed.data === 'llamaServer' ? 'llamaServerPath' : 'modelsDir', path)
  })

  ipcMain.handle(ipcChannels.filesBundledLlama, async (event): Promise<LlamaInfo> => {
    assertFromApp(event)
    return llamaInfo()
  })

  // Takes no argument: "none chosen" is the only value the UI can ask for, so it can't smuggle in a path.
  ipcMain.handle(ipcChannels.filesUseBundledLlama, async (event): Promise<Settings> => {
    assertFromApp(event)
    return setModelPath('llamaServerPath', null)
  })

  // The UI names one of our folders; it can never make Explorer open (or run) a path of its choosing.
  ipcMain.handle(ipcChannels.filesOpenFolder, async (event, folder: unknown): Promise<void> => {
    assertFromApp(event)
    const parsed = appFolderSchema.safeParse(folder)
    if (!parsed.success) {
      log.warn('Refused to open an unknown folder', folder)
      throw new Error('Unknown folder')
    }
    // openPath resolves with an error message instead of rejecting.
    const failure = await shell.openPath(folders[parsed.data])
    if (failure) {
      log.warn(`Could not open the ${parsed.data} folder: ${failure}`)
      throw new Error('The folder could not be opened')
    }
  })
}
