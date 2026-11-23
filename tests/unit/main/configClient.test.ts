// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import {
  ConfigConflictError,
  ConfigInvalidError,
  ConfigUnavailableError,
  createConfigClient,
  type ConfigClient,
  type EngineEntry,
  type EngineSection,
  type LlamacppEntry,
  type LlamacppSection
} from '../../../src/main/core/configClient'

type Request = (path: string, init?: RequestInit) => Promise<Response>

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

const engineValue: EngineSection = { path: null, build: 'bundled' }
const llamacppValue: LlamacppSection = {
  modelsDir: 'D:\\Models',
  embeddingModel: null,
  idleUnloadMinutes: 15,
  options: { qwen: { args: '--jinja', context: 8192 } }
}
const engineEntry = (rev: number, value: EngineSection = engineValue): EngineEntry => ({
  rev,
  value,
  effective: { path: 'C:\\app\\llama-server.exe' }
})
const llamacppEntry = (rev: number, value: LlamacppSection = llamacppValue): LlamacppEntry => ({
  rev,
  value,
  effective: { modelsDir: 'D:\\Models' }
})

/** Each section's path, calls and a valid entry, so one table covers both. */
const sections = [
  {
    name: 'engine.llamaserver',
    path: '/api/config/engine.llamaserver',
    entry: (rev: number): unknown => engineEntry(rev),
    value: engineValue as unknown,
    malformed: { ...engineEntry(1), value: { ...engineValue, build: 'vulkan' } },
    get: (client: ConfigClient) => client.getEngine(),
    put: (client: ConfigClient, rev: number) => client.putEngine(rev, engineValue)
  },
  {
    name: 'provider.llamacpp',
    path: '/api/config/provider.llamacpp',
    entry: (rev: number): unknown => llamacppEntry(rev),
    value: llamacppValue as unknown,
    malformed: { ...llamacppEntry(1), value: { ...llamacppValue, idleUnloadMinutes: 0 } },
    get: (client: ConfigClient) => client.getLlamacpp(),
    put: (client: ConfigClient, rev: number) => client.putLlamacpp(rev, llamacppValue)
  }
]

describe.each(sections)('config client: $name', (section) => {
  it('reads the section', async () => {
    const request = vi.fn<Request>().mockResolvedValue(json(section.entry(3)))

    await expect(section.get(createConfigClient(request))).resolves.toEqual(section.entry(3))
    expect(request).toHaveBeenCalledWith(section.path)
  })

  it('writes the whole section with its rev as JSON', async () => {
    const request = vi.fn<Request>().mockResolvedValue(json(section.entry(4)))

    await expect(section.put(createConfigClient(request), 3)).resolves.toEqual(section.entry(4))
    expect(request).toHaveBeenCalledWith(section.path, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rev: 3, value: section.value })
    })
  })

  it('a 409 carries the current entry of that section', async () => {
    const request = vi.fn<Request>().mockResolvedValue(
      json(
        {
          error: 'config_conflict',
          message: 'the section changed since it was read',
          current: section.entry(5)
        },
        409
      )
    )

    const error: unknown = await section.put(createConfigClient(request), 3).catch((e: unknown) => e)

    expect(error).toBeInstanceOf(ConfigConflictError)
    expect((error as ConfigConflictError<unknown>).message).toBe('the section changed since it was read')
    expect((error as ConfigConflictError<unknown>).current).toEqual(section.entry(5))
  })

  it("a 400 rejects with core's message as ConfigInvalidError", async () => {
    const request = vi
      .fn<Request>()
      .mockResolvedValue(json({ error: 'invalid_config', message: 'path must be an absolute path' }, 400))

    const put = section.put(createConfigClient(request), 0)

    await expect(put).rejects.toBeInstanceOf(ConfigInvalidError)
    await expect(put).rejects.toThrow('path must be an absolute path')
  })

  it('a 503 rejects as ConfigUnavailableError', async () => {
    const request = vi
      .fn<Request>()
      .mockResolvedValue(
        json({ error: 'config_unavailable', message: 'config storage is not available' }, 503)
      )

    await expect(section.put(createConfigClient(request), 0)).rejects.toBeInstanceOf(ConfigUnavailableError)
  })

  it("another status rejects with core's message", async () => {
    const request = vi
      .fn<Request>()
      .mockResolvedValue(json({ error: 'not_found', message: 'no such route' }, 404))

    const get = section.get(createConfigClient(request))

    await expect(get).rejects.toThrow('no such route')
    await expect(get).rejects.not.toBeInstanceOf(ConfigInvalidError)
  })

  it.each([
    ['a value core would refuse', section.malformed],
    ['missing effective', { rev: 1, value: section.value }]
  ])('a malformed answer is refused (%s)', async (_case, body) => {
    const request = vi.fn<Request>().mockResolvedValue(json(body))

    await expect(section.get(createConfigClient(request))).rejects.toThrow('core sent a malformed config')
  })

  it("core not running rejects with the request's error", async () => {
    const down = new Error('core is not running')
    const request = vi.fn<Request>().mockRejectedValue(down)

    await expect(section.get(createConfigClient(request))).rejects.toBe(down)
  })
})

describe('getEngine', () => {
  it("reads a section with build 'auto'", async () => {
    const entry = engineEntry(2, { path: null, build: 'auto' })
    const request = vi.fn<Request>().mockResolvedValue(json(entry))

    await expect(createConfigClient(request).getEngine()).resolves.toEqual(entry)
  })
})

describe('setModelPath', () => {
  const put = (call: unknown[]): { rev: number; value: unknown } =>
    JSON.parse((call[1] as RequestInit).body as string)

  it("'llamaServer' writes only the engine section's path", async () => {
    const request = vi
      .fn<Request>()
      .mockResolvedValueOnce(json(engineEntry(3)))
      .mockResolvedValueOnce(json(engineEntry(4)))

    await createConfigClient(request).setModelPath('llamaServer', 'C:\\llama\\llama-server.exe')

    expect(request.mock.calls.map((call) => call[0])).toEqual([
      '/api/config/engine.llamaserver',
      '/api/config/engine.llamaserver'
    ])
    expect(put(request.mock.calls[1])).toEqual({
      rev: 3,
      value: { ...engineValue, path: 'C:\\llama\\llama-server.exe' }
    })
  })

  it("'modelsDir' writes only the provider section's modelsDir", async () => {
    const request = vi
      .fn<Request>()
      .mockResolvedValueOnce(json(llamacppEntry(3)))
      .mockResolvedValueOnce(json(llamacppEntry(4)))

    await createConfigClient(request).setModelPath('modelsDir', 'E:\\Models')

    expect(request.mock.calls.map((call) => call[0])).toEqual([
      '/api/config/provider.llamacpp',
      '/api/config/provider.llamacpp'
    ])
    expect(put(request.mock.calls[1])).toEqual({
      rev: 3,
      value: { ...llamacppValue, modelsDir: 'E:\\Models' }
    })
  })

  it('a conflict PUTs again on the current entry, keeping its other values', async () => {
    const current = engineEntry(5, { path: null, build: 'cuda' })
    const request = vi
      .fn<Request>()
      .mockResolvedValueOnce(json(engineEntry(3)))
      .mockResolvedValueOnce(json({ error: 'config_conflict', message: 'changed', current }, 409))
      .mockResolvedValueOnce(json(engineEntry(6)))

    await createConfigClient(request).setModelPath('llamaServer', 'C:\\llama\\llama-server.exe')

    expect(put(request.mock.calls[2])).toEqual({
      rev: 5,
      value: { ...current.value, path: 'C:\\llama\\llama-server.exe' }
    })
  })

  it('a second conflict rejects with ConfigConflictError', async () => {
    const conflict = (rev: number): Response =>
      json({ error: 'config_conflict', message: 'changed', current: llamacppEntry(rev) }, 409)
    const request = vi
      .fn<Request>()
      .mockResolvedValueOnce(json(llamacppEntry(3)))
      .mockResolvedValueOnce(conflict(4))
      .mockResolvedValueOnce(conflict(5))

    await expect(createConfigClient(request).setModelPath('modelsDir', 'E:\\M')).rejects.toBeInstanceOf(
      ConfigConflictError
    )
    expect(request).toHaveBeenCalledTimes(3)
  })

  it('a 503 on the GET rejects with ConfigUnavailableError and PUTs nothing', async () => {
    const request = vi
      .fn<Request>()
      .mockResolvedValue(
        json({ error: 'config_unavailable', message: 'config storage is not available' }, 503)
      )

    await expect(createConfigClient(request).setModelPath('modelsDir', 'E:\\M')).rejects.toBeInstanceOf(
      ConfigUnavailableError
    )
    expect(request).toHaveBeenCalledTimes(1)
  })
})
