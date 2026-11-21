import { BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import { log } from '../logger'
import { isAppUrl } from '../urlPolicy'

export interface SenderCheck {
  /** Throws 'Request refused' (and logs a warning) unless the sender frame is our own UI page. */
  assertFromApp(event: IpcMainInvokeEvent): void
  /** assertFromApp, then the BrowserWindow that sent it; throws 'No window for this request' if none. */
  senderWindow(event: IpcMainInvokeEvent): BrowserWindow
}

export function createSenderCheck(appUrl: string): SenderCheck {
  /** Answers only our own UI page; the navigation guards should make anything else impossible, this double-checks. */
  function assertFromApp(event: IpcMainInvokeEvent): void {
    const url = event.senderFrame?.url ?? ''
    if (!isAppUrl(url, appUrl)) {
      log.warn(`Refused an IPC request from ${url || 'an unknown frame'}`)
      throw new Error('Request refused')
    }
  }

  /** The window that sent the request: the buttons act on their own window, never another. */
  function senderWindow(event: IpcMainInvokeEvent): BrowserWindow {
    assertFromApp(event)
    const window = BrowserWindow.fromWebContents(event.sender)
    if (!window) throw new Error('No window for this request')
    return window
  }

  return { assertFromApp, senderWindow }
}
