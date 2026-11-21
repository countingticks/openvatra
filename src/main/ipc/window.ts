import { ipcMain } from 'electron'
import { z } from 'zod'
import { editCommands, ipcChannels } from '../../shared/ipc'
import { log } from '../logger'
import type { SenderCheck } from './sender'

const editCommandSchema = z.enum(editCommands)

export function registerWindowIpc(sender: SenderCheck): void {
  const { senderWindow } = sender

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
}
