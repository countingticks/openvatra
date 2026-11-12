// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import {
  ConfigConflictError,
  ConfigInvalidError,
  ConfigUnavailableError,
  createConfigClient,
  type CoreModels,
  type ModelsEntry
} from '../../../src/main/core/configClient'

type Request = (path: string, init?: RequestInit) => Promise<Response>

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

const value: CoreModels = {
  llamaServerPath: null,
  modelsDir: 'D:\\Models',
  embeddingModel: null,
  idleUnloadMinutes: 15,
  options: { qwen: { args: '-c 8192' } },
  engine: 'bundled'
}
const entry = (rev: number, models: CoreModels = value): ModelsEntry => ({
  rev,
  value: models,
  effective: { llamaServerPath: 'C:\\app\\llama-server.exe', modelsDir: 'D:\\Models' }
})

describe('config client', () => {
  it('reads the models section', async () => {
    const request = vi.fn<Request>().mockResolvedValue(json(entry(3)))

    await expect(createConfigClient(request).getModels()).resolves.toEqual(entry(3))
    expect(request).toHaveBeenCalledWith('/api/config/models')
  })

  it('writes the whole section with its rev as JSON', async () => {
    const request = vi.fn<Request>().mockResolvedValue(json(entry(4)))

    await expect(createConfigClient(request).putModels(3, value)).resolves.toEqual(entry(4))
    expect(request).toHaveBeenCalledWith('/api/config/models', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rev: 3, value })
    })
  })

  it('a 409 carries the current entry', async () => {
    const request = vi
      .fn<Request>()
      .mockResolvedValue(
        json(
          { error: 'config_conflict', message: 'the section changed since it was read', current: entry(5) },
          409
        )
      )

    const error: unknown = await createConfigClient(request)
      .putModels(3, value)
      .catch((e: unknown) => e)

    expect(error).toBeInstanceOf(ConfigConflictError)
    expect((error as ConfigConflictError).message).toBe('the section changed since it was read')
    expect((error as ConfigConflictError).current).toEqual(entry(5))
  })

  it("a 400 rejects with core's message as ConfigInvalidError", async () => {
    const request = vi
      .fn<Request>()
      .mockResolvedValue(
        json({ error: 'invalid_config', message: 'modelsDir must be an absolute path' }, 400)
      )

    const put = createConfigClient(request).putModels(0, value)

    await expect(put).rejects.toBeInstanceOf(ConfigInvalidError)
    await expect(put).rejects.toThrow('modelsDir must be an absolute path')
  })

  it('a 503 rejects as ConfigUnavailableError', async () => {
    const request = vi
      .fn<Request>()
      .mockResolvedValue(
        json({ error: 'config_unavailable', message: 'config storage is not available' }, 503)
      )

    await expect(createConfigClient(request).putModels(0, value)).rejects.toBeInstanceOf(
      ConfigUnavailableError
    )
  })

  it("another status rejects with core's message", async () => {
    const request = vi
      .fn<Request>()
      .mockResolvedValue(json({ error: 'unknown_section', message: 'no such section' }, 404))

    const get = createConfigClient(request).getModels()

    await expect(get).rejects.toThrow('no such section')
    await expect(get).rejects.not.toBeInstanceOf(ConfigInvalidError)
  })

  it.each([
    ['idleUnloadMinutes: 0', { ...entry(1), value: { ...value, idleUnloadMinutes: 0 } }],
    ['missing effective', { rev: 1, value }]
  ])('a malformed answer is refused (%s)', async (_case, body) => {
    const request = vi.fn<Request>().mockResolvedValue(json(body))

    await expect(createConfigClient(request).getModels()).rejects.toThrow('core sent a malformed config')
  })

  it("core not running rejects with the request's error", async () => {
    const down = new Error('core is not running')
    const request = vi.fn<Request>().mockRejectedValue(down)

    await expect(createConfigClient(request).getModels()).rejects.toBe(down)
  })
})
