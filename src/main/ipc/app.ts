import { app, ipcMain } from 'electron'
import { ipcChannels } from '../../shared/ipc'
import type { SenderCheck } from './sender'

export function registerAppIpc(sender: SenderCheck): void {
  ipcMain.handle(ipcChannels.appQuit, (event) => {
    sender.assertFromApp(event)
    app.quit()
  })
}
