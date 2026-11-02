// Start with Windows: an entry in the user's Run list (HKCU\...\CurrentVersion\Run), written by Electron.
import { app } from 'electron'
import { log } from './logger'

/** Part of the login command, so a start at login can be told apart from the user opening the app. */
export const startedAtLoginArg = '--started-at-login'

export function wasStartedAtLogin(argv: readonly string[]): boolean {
  return argv.includes(startedAtLoginArg)
}

/** Adds or removes OpenVatra from the programs Windows starts at login. */
export function applyStartWithWindows(enabled: boolean): void {
  // Only the installed app registers itself. In development and tests the executable is a bare electron.exe:
  // registering it would start an empty Electron at every login, and each test run would edit the registry.
  if (!app.isPackaged) {
    log.info(`Start with Windows ${enabled ? 'on' : 'off'}; not registered, the app is not installed`)
    return
  }
  try {
    app.setLoginItemSettings({ openAtLogin: enabled, args: [startedAtLoginArg] })
    log.info(`Start with Windows ${enabled ? 'on' : 'off'}`)
  } catch (error) {
    // The setting is saved either way; the next launch tries again.
    log.warn('Start with Windows could not be changed', error)
  }
}
