// The llama.cpp build that ships with the app (resources/llama, fetched by scripts/fetch-llama.mjs). Settings keep
// `llamaServerPath: null` for "use the bundled one"; main turns that into this path before core ever sees it.
// No Electron imports (the caller passes the folder), so it's unit-testable.
import { access, readdir, readFile } from 'fs/promises'
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

/** The release tag pinned in llama.json: the one the bundled build and the CUDA download both belong to. */
export async function readPinnedTag(manifestPath: string): Promise<string | null> {
  try {
    const { tag } = JSON.parse(await readFile(manifestPath, 'utf8')) as { tag?: unknown }
    return typeof tag === 'string' && tag ? tag : null
  } catch {
    return null
  }
}

/** `ready`: the CUDA build for the pinned tag is installed. `stale`: only one from an older tag. `none`: nothing. */
export type CudaStatus = 'none' | 'ready' | 'stale'

const cudaFolder = (tag: string): string => `${tag}-cuda`

async function hasServer(dir: string): Promise<boolean> {
  try {
    await access(bundledLlamaExe(dir))
    return true
  } catch {
    return false
  }
}

/**
 * Looks in the engines folder (core puts `<tag>-cuda` there, and only once it is complete). An app update moves the
 * pinned tag, so an older folder is "stale": still on disk, but not what we'd run.
 */
export async function cudaStatus(enginesDir: string, tag: string | null): Promise<CudaStatus> {
  if (tag && (await hasServer(join(enginesDir, cudaFolder(tag))))) return 'ready'
  let names: string[]
  try {
    names = await readdir(enginesDir)
  } catch {
    return 'none'
  }
  for (const name of names) {
    if (
      name.endsWith('-cuda') &&
      name !== (tag && cudaFolder(tag)) &&
      (await hasServer(join(enginesDir, name)))
    )
      return 'stale'
  }
  return 'none'
}

/**
 * The llama-server to run when the user hasn't picked their own: the CUDA build if they chose it and it matches
 * this app's tag, else the bundled one. (A custom path is applied before this, in configSync, and always wins.)
 */
export async function defaultLlamaServer(
  engine: 'bundled' | 'cuda',
  bundledDir: string,
  enginesDir: string,
  tag: string | null
): Promise<string> {
  if (engine === 'cuda' && tag && (await cudaStatus(enginesDir, tag)) === 'ready')
    return bundledLlamaExe(join(enginesDir, cudaFolder(tag)))
  return bundledLlamaExe(bundledDir)
}
