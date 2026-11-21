import { ipcMain } from 'electron'
import { ipcChannels } from '../../shared/ipc'
import type { Settings } from '../../shared/settings'
import { log } from '../logger'
import type { IpcDeps } from './index'
import type { SenderCheck } from './sender'

export function registerSettingsIpc({ settings }: Pick<IpcDeps, 'settings'>, sender: SenderCheck): void {
  ipcMain.handle(ipcChannels.settingsGet, (event): Settings => {
    sender.assertFromApp(event)
    return settings.get()
  })

  ipcMain.handle(ipcChannels.settingsUpdate, async (event, patch: unknown): Promise<Settings> => {
    sender.assertFromApp(event)
    try {
      return await settings.update(patch)
    } catch (error) {
      // Details go to the log; the UI gets a short message, not our internals.
      log.warn('Settings update rejected', error)
      // Electron sends only the message to the UI; the cause stays in main.
      throw new Error('Settings could not be updated', { cause: error })
    }
  })
}
