// @vitest-environment node
import { describe, expect, it, type Mock, vi } from 'vitest'
import { createConfigClient, type CoreModels, type ModelsEntry } from '../../../src/main/core/configClient'
import { importLegacyModels, type ImportLog } from '../../../src/main/core/legacyImport'

type Request = (path: string, init?: RequestInit) => Promise<Response>

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

const defaults: CoreModels = {
  llamaServerPath: null,
  modelsDir: null,
  embeddingModel: null,
  idleUnloadMinutes: 15,
  options: {},
  engine: 'bundled'
}
const legacy: CoreModels = {
  llamaServerPath: 'D:\\llama\\llama-server.exe',
  modelsDir: 'D:\\Models',
  embeddingModel: 'nomic',
  idleUnloadMinutes: 30,
  options: { qwen: { args: '-c 8192 --jinja' }, gemma: { args: '-ngl 99' } },
  engine: 'cuda'
}
const entry = (rev: number, value: CoreModels = defaults): ModelsEntry => ({
  rev,
  value,
  effective: { llamaServerPath: 'C:\\app\\llama-server.exe', modelsDir: 'C:\\Users\\me\\OpenVatra\\Models' }
})
const invalid = (message: string): Response => json({ error: 'invalid_config', message }, 400)

/** core answers the requests in order; the PUT bodies are kept. */
function setUp(...answers: (Response | Error)[]): {
  run: () => ReturnType<typeof importLegacyModels>
  puts: () => { rev: number; value: CoreModels }[]
  log: { [K in keyof ImportLog]: Mock }
} {
  const request = vi.fn<Request>(async () => {
    const answer = answers.shift()
    if (answer instanceof Error) throw answer
    if (!answer) throw new Error('no answer left')
    return answer
  })
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
  return {
    run: () => importLegacyModels(createConfigClient(request), legacy, log),
    puts: () =>
      request.mock.calls
        .filter(([, init]) => init?.method === 'PUT')
        .map(([, init]) => JSON.parse(init?.body as string) as { rev: number; value: CoreModels }),
    log
  }
}

describe('importLegacyModels', () => {
  it('imports when core has never been written', async () => {
    const { run, puts, log } = setUp(json(entry(0)), json(entry(1, legacy)))

    await expect(run()).resolves.toBe('imported')

    expect(puts()).toEqual([{ rev: 0, value: legacy }])
    expect(log.info).toHaveBeenCalledWith('Model settings imported into core')
  })

  it('drops the old copy when core already has a config', async () => {
    const { run, puts, log } = setUp(json(entry(3)))

    await expect(run()).resolves.toBe('core-had-config')

    expect(puts()).toEqual([])
    expect(log.info).toHaveBeenCalledWith(
      'Model settings: core already has them; dropped the old copy in settings.json'
    )
  })

  it('core wins a conflict', async () => {
    const { run, puts } = setUp(
      json(entry(0)),
      json(
        { error: 'config_conflict', message: 'the section changed since it was read', current: entry(1) },
        409
      )
    )

    await expect(run()).resolves.toBe('conflict')
    expect(puts()).toHaveLength(1)
  })

  it.each([
    ['modelsDir', 'modelsDir must be an absolute path', { ...legacy, modelsDir: null }],
    [
      'options for "qwen"',
      'options for "qwen": unclosed quote',
      { ...legacy, options: { gemma: { args: '-ngl 99' } } }
    ]
  ])(
    'an invalid field is reset as core names it and the retry imports the rest (%s)',
    async (_case, message, retried) => {
      const { run, puts, log } = setUp(json(entry(0)), invalid(message), json(entry(1, retried)))

      await expect(run()).resolves.toBe('imported')

      expect(puts()).toEqual([
        { rev: 0, value: legacy },
        { rev: 0, value: retried }
      ])
      expect(log.warn).toHaveBeenCalledWith(expect.stringContaining(message))
    }
  )

  it('gives up after one failed retry', async () => {
    const { run, puts, log } = setUp(
      json(entry(0)),
      invalid('engine must be "bundled" or "cuda"'),
      invalid('engine must be "bundled" or "cuda"')
    )

    await expect(run()).resolves.toBe('gave-up')

    expect(puts()).toHaveLength(2)
    expect(puts()[1].value.engine).toBe('bundled')
    expect(log.error).toHaveBeenCalledWith(
      "Model settings could not be imported; using core's defaults",
      expect.any(Error)
    )
  })

  it('keeps the old copy when the database is unavailable', async () => {
    const { run, log } = setUp(
      json(entry(0)),
      json({ error: 'config_unavailable', message: 'config storage is not available' }, 503)
    )

    await expect(run()).resolves.toBe('retry-later')
    expect(log.warn).toHaveBeenCalledWith('Model settings import postponed', expect.any(Error))
  })

  it('keeps the old copy when core is not reachable', async () => {
    const { run, log } = setUp(new Error('core is not running'))

    await expect(run()).resolves.toBe('retry-later')
    expect(log.warn).toHaveBeenCalledWith('Model settings import postponed', expect.any(Error))
  })
})
