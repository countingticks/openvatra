// Whether the Windows taskbar is light or dark, so the tray icon stays visible on it.
// Windows keeps the taskbar ("Windows mode") separate from apps ("app mode"); Electron's nativeTheme only tells
// the apps mode, and later follows our own Light/Dark override too, so the taskbar setting is read directly.
import { execFile } from 'child_process'

const personalizeKey = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize'

/** True for a light taskbar. Falls back to dark, the Windows default, if the setting can't be read. */
export function readTaskbarIsLight(): Promise<boolean> {
  return new Promise((resolve) => {
    // reg.exe ships with Windows; reading one value needs no native module.
    execFile('reg', ['query', personalizeKey, '/v', 'SystemUsesLightTheme'], (error, stdout) => {
      resolve(!error && parseRegDword(stdout, 'SystemUsesLightTheme') === 1)
    })
  })
}

/** Reads one REG_DWORD value from `reg query` output; undefined if it isn't there. */
export function parseRegDword(output: string, name: string): number | undefined {
  const match = new RegExp(`^\\s*${name}\\s+REG_DWORD\\s+0x([0-9a-f]+)\\s*$`, 'im').exec(output)
  return match ? parseInt(match[1], 16) : undefined
}
