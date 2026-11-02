// Every e2e run gets a fresh, empty user-data folder, so tests never read or change the developer's real
// %APPDATA%\OpenVatra (settings, logs) and always start from a first launch.
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

export async function createUserDataDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'openvatra-e2e-'))
}

/** Arguments that start this project's built app with `userDataDir` as its profile. */
export function appArgs(userDataDir: string): string[] {
  // '.' starts Electron with this project: package.json "main" points to the built out/main/index.js.
  return ['.', `--user-data-dir=${userDataDir}`]
}

export async function removeUserDataDir(userDataDir: string): Promise<void> {
  // Windows can hold a file open for a moment after the app quits; retry instead of failing the run.
  await rm(userDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
}
