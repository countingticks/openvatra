import { ipcMain, shell } from 'electron'
import { join } from 'path'
import { ipcChannels } from '../../shared/ipc'
import type { CoreState } from '../../shared/core'
import type { Host } from '../core/host'
import { log } from '../logger'
import type { IpcDeps } from './index'
import type { SenderCheck } from './sender'

/** The parts of the host client the UI may use. */
export type CoreControl = Pick<Host, 'state' | 'restart'>

export function registerCoreIpc(
  { locations, core }: Pick<IpcDeps, 'locations' | 'core'>,
  sender: SenderCheck
): void {
  ipcMain.handle(ipcChannels.coreGetState, (event): CoreState => {
    sender.assertFromApp(event)
    return core.state()
  })

  ipcMain.handle(ipcChannels.coreRestart, async (event): Promise<void> => {
    sender.assertFromApp(event)
    log.info('core: restart requested from the UI')
    await core.restart()
  })

  // No argument: the UI cannot choose which file opens.
  ipcMain.handle(ipcChannels.coreOpenLog, async (event): Promise<void> => {
    sender.assertFromApp(event)
    const logFile = join(locations.logsFolder, 'main.log')
    // A .log file may have no default app; then show it in Explorer instead.
    const failure = await shell.openPath(logFile)
    if (failure) {
      log.warn(`Could not open the log: ${failure}`)
      shell.showItemInFolder(logFile)
    }
  })
}
