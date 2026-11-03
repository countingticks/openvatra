// IPC handlers: main's side of the contract in src/shared/ipc.ts. Every request is treated as untrusted.
import { BrowserWindow, ipcMain, shell, type IpcMainInvokeEvent } from 'electron'
import { dirname } from 'path'
import { z } from 'zod'
import { appFolders, ipcChannels, type AppFolder, type FileLocations } from '../shared/ipc'
import type { Settings } from '../shared/settings'
import { log } from './logger'
import type { SettingsStore } from './settingsStore'
import { isAppUrl } from './urlPolicy'

const appFolderSchema = z.enum(appFolders)

export function registerIpcHandlers(store: SettingsStore, appUrl: string, locations: FileLocations): void {
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
    return store.get()
  })

  ipcMain.handle(ipcChannels.settingsUpdate, async (event, patch: unknown): Promise<Settings> => {
    assertFromApp(event)
    try {
      return await store.update(patch)
    } catch (error) {
      // Details go to the log; the UI gets a short message, not our internals.
      log.warn('Settings update rejected', error)
      // Electron sends only the message to the UI; the cause stays in main.
      throw new Error('Settings could not be updated', { cause: error })
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
