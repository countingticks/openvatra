// The llama.cpp build that ships with the app (resources/llama, fetched by scripts/fetch-llama.mjs). Settings keep
// `llamaServerPath: null` for "use the bundled one"; main turns that into this path before core ever sees it.
// No Electron imports (the caller passes the folder), so it's unit-testable.
import { readFile } from 'fs/promises'
import { join } from 'path'

/** The folder holding llama-server.exe: `<resources>/llama` installed, `resources/llama/bin` in development. */
export function bundledLlamaDir(packaged: boolean, resourcesPath: string, appPath: string): string {
  return packaged ? join(resourcesPath, 'llama') : join(appPath, 'resources', 'llama', 'bin')
}

/** The pin file: beside the exe's folder in development (it is not inside bin/), inside it once installed. */
export function llamaManifestPath(packaged: boolean, resourcesPath: string, appPath: string): string {
  return packaged
    ? join(resourcesPath, 'llama', 'llama.json')
    : join(appPath, 'resources', 'llama', 'llama.json')
}

export function bundledLlamaExe(dir: string): string {
  return join(dir, 'llama-server.exe')
}

/** The release tag (e.g. "b12078") the fetch script wrote beside the exe; null if the file isn't there. */
export async function readBundledTag(dir: string): Promise<string | null> {
  try {
    return (await readFile(join(dir, '.tag'), 'utf8')).trim() || null
  } catch {
    return null
  }
}
