// One log file for bug reports: %APPDATA%\OpenVatra\logs\main.log (electron-log uses app.getPath('logs')).
import { dirname } from 'path'
import log from 'electron-log/main'

/** The folder the log file is in, as electron-log resolves it (so Settings shows where it really writes). */
export function logsFolder(): string {
  return dirname(log.transports.file.getFile().path)
}

export function setUpLogging(): void {
  // info and above: milestones and problems, without debug noise.
  log.transports.file.level = 'info'
  // Rotation: past 1 MB, main.log becomes main.old.log (replacing the previous one), so logs stay ~2 MB at most.
  log.transports.file.maxSize = 1024 ** 2
  // Crashes end up in the file too. No dialog: the user can't act on a stack trace.
  log.errorHandler.startCatching({ showDialog: false })
}

export { log }
