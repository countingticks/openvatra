// IPC handlers: main's side of the contract in src/shared/ipc.ts. Every request is treated as untrusted.
import type { FileLocations } from '../../shared/ipc'
import type { ChatExport } from '../core/chatExport'
import type { ConfigClient } from '../core/configClient'
import type { SettingsService } from '../settingsService'
import { registerAppIpc } from './app'
import { registerCoreIpc, type CoreControl } from './core'
import { registerFilesIpc } from './files'
import { createSenderCheck } from './sender'
import { registerSettingsIpc } from './settings'
import { registerWindowIpc } from './window'

export type { CoreControl } from './core'

export interface IpcDeps {
  settings: SettingsService
  appUrl: string
  locations: FileLocations
  config: Pick<ConfigClient, 'getEngine' | 'getLlamacpp' | 'setModelPath'>
  core: CoreControl
  chats: ChatExport
}

export function registerIpc(deps: IpcDeps): void {
  const sender = createSenderCheck(deps.appUrl)
  registerSettingsIpc(deps, sender)
  registerFilesIpc(deps, sender)
  registerWindowIpc(sender)
  registerAppIpc(sender)
  registerCoreIpc(deps, sender)
}
