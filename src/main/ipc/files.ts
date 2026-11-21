import { app, dialog, ipcMain, shell } from 'electron'
import { writeFile } from 'fs/promises'
import { dirname, join } from 'path'
import { z } from 'zod'
import { appFolders, ipcChannels, pickTargets, type AppFolder, type FileLocations } from '../../shared/ipc'
import { log } from '../logger'
import type { IpcDeps } from './index'
import type { SenderCheck } from './sender'

const appFolderSchema = z.enum(appFolders)
const pickTargetSchema = z.enum(pickTargets)
const chatIdSchema = z.string().regex(/^[0-9a-f-]{36}$/)

export function registerFilesIpc(
  { locations, config, chats }: Pick<IpcDeps, 'locations' | 'config' | 'chats'>,
  sender: SenderCheck
): void {
  const folders: Record<AppFolder, string> = {
    settings: dirname(locations.settingsFile),
    logs: locations.logsFolder
  }

  ipcMain.handle(ipcChannels.filesLocations, (event): FileLocations => {
    sender.assertFromApp(event)
    return locations
  })

  // The UI only names what to pick; the path comes from Windows' own dialog, so it is always the user's choice.
  ipcMain.handle(ipcChannels.filesPick, async (event, target: unknown): Promise<boolean> => {
    const window = sender.senderWindow(event)
    const parsed = pickTargetSchema.safeParse(target)
    if (!parsed.success) {
      log.warn('Refused to pick an unknown path', target)
      throw new Error('Unknown path')
    }
    const chosen = parsed.data
    // Only a starting folder: the dialog still opens when core can't be read.
    const stored =
      chosen === 'llamaServer'
        ? config.getEngine().then((entry) => entry.value.path)
        : config.getLlamacpp().then((entry) => entry.value.modelsDir)
    const current = await stored.then((path) => path ?? undefined).catch(() => undefined)
    const result =
      chosen === 'llamaServer'
        ? await dialog.showOpenDialog(window, {
            title: 'Choose llama-server.exe',
            defaultPath: current,
            filters: [{ name: 'llama-server', extensions: ['exe'] }],
            properties: ['openFile']
          })
        : await dialog.showOpenDialog(window, {
            title: 'Choose the models folder',
            defaultPath: current,
            properties: ['openDirectory']
          })
    const [path] = result.filePaths
    if (result.canceled || !path) return false
    try {
      await config.setModelPath(chosen, path)
      return true
    } catch (error) {
      log.warn(`Could not set the ${chosen === 'llamaServer' ? 'llama-server path' : 'models folder'}`, error)
      // Electron sends only the message to the UI; the cause stays in main.
      throw new Error(error instanceof Error ? error.message : String(error), { cause: error })
    }
  })

  // The UI names only the chat: main reads its text from core and the path comes from Windows' own Save dialog.
  ipcMain.handle(ipcChannels.filesExportChat, async (event, chatId: unknown): Promise<boolean> => {
    const window = sender.senderWindow(event)
    const parsed = chatIdSchema.safeParse(chatId)
    if (!parsed.success) {
      log.warn('Refused to export an unknown chat', chatId)
      throw new Error('Unknown chat')
    }
    const { fileName, markdown } = await chats.read(parsed.data)
    const result = await dialog.showSaveDialog(window, {
      title: 'Export chat',
      defaultPath: join(app.getPath('documents'), fileName),
      filters: [{ name: 'Markdown', extensions: ['md'] }]
    })
    if (result.canceled || !result.filePath) return false
    try {
      await writeFile(result.filePath, markdown, 'utf8')
      return true
    } catch (error) {
      log.warn('Could not save the chat export', error)
      throw new Error('The file could not be saved', { cause: error })
    }
  })

  // The UI names one of our folders; it can never make Explorer open (or run) a path of its choosing.
  ipcMain.handle(ipcChannels.filesOpenFolder, async (event, folder: unknown): Promise<void> => {
    sender.assertFromApp(event)
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
