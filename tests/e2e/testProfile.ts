// Every e2e run gets a fresh, empty user-data folder, so tests never read or change the developer's real
// %APPDATA%\OpenVatra (settings, logs) and always start from a first launch.
import { mkdtemp, readFile, rm } from 'fs/promises'
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

/**
 * Waits (30 s) for core.json and a 200 from core, and returns the shell's port and token. Reads the test's own
 * (temporary) core.json: never use it on a real profile.
 */
export async function waitForCore(userDataDir: string): Promise<{ port: number; token: string }> {
  const deadline = Date.now() + 30_000
  let discovery: { port: number; token: string } | undefined
  while (!discovery) {
    try {
      discovery = JSON.parse(await readFile(join(userDataDir, 'data', 'core.json'), 'utf8')) as {
        port: number
        token: string
      }
      const alive = await fetch(`http://127.0.0.1:${discovery.port}/api/config/engine.llamaserver`, {
        headers: { Authorization: `Bearer ${discovery.token}` }
      })
      if (!alive.ok) discovery = undefined
    } catch {
      discovery = undefined
    }
    if (!discovery) {
      if (Date.now() > deadline) throw new Error('core did not become ready')
      await new Promise((resolve) => setTimeout(resolve, 200))
    }
  }
  return discovery
}

/**
 * Points core at a fake llama-server and / or a models folder: settings.json no longer carries model settings, and the
 * engine path can only be set with the shell token, so this reads it from the test's own (temporary) core.json and
 * waits for core to be up. Never use it on a real profile.
 */
export async function seedCoreModels(
  userDataDir: string,
  seed: {
    llamaServerPath?: string
    modelsDir?: string
    lastModel?: string
    placement?: { model: string; placement: string }
  }
): Promise<void> {
  const { port, token } = await waitForCore(userDataDir)
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
  const set = async (section: string, change: Record<string, unknown>): Promise<void> => {
    const url = `http://127.0.0.1:${port}/api/config/${section}`
    const current = (await (await fetch(url, { headers })).json()) as { rev: number; value: object }
    const body = JSON.stringify({ rev: current.rev, value: { ...current.value, ...change } })
    const response = await fetch(url, { method: 'PUT', headers, body })
    if (!response.ok) throw new Error(`${section} was refused: ${await response.text()}`)
  }
  if (seed.llamaServerPath) await set('engine.llamaserver', { path: seed.llamaServerPath })
  if (seed.modelsDir || seed.placement) {
    await set('provider.llamacpp', {
      ...(seed.modelsDir ? { modelsDir: seed.modelsDir } : {}),
      ...(seed.placement
        ? { options: { [seed.placement.model]: { placement: seed.placement.placement } } }
        : {})
    })
  }
  if (seed.lastModel) await set('chat', { lastModel: seed.lastModel })
}
