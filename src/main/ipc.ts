// IPC handlers: main's side of the contract in src/shared/ipc.ts. Every request is treated as untrusted.
import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import { ipcChannels } from '../shared/ipc'
import type { Settings } from '../shared/settings'
import { log } from './logger'
import type { SettingsStore } from './settingsStore'
import { isAppUrl } from './urlPolicy'

export function registerIpcHandlers(store: SettingsStore, appUrl: string): void {
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
}
