// @vitest-environment node
import { describe, expect, it, type Mock, vi } from 'vitest'
import {
  ConfigConflictError,
  ConfigInvalidError,
  ConfigUnavailableError,
  type ConfigClient,
  type EngineEntry,
  type EngineSection,
  type LlamacppEntry,
  type LlamacppSection
} from '../../../src/main/core/configClient'
import { importLegacyModels, splitLegacy, type ImportLog } from '../../../src/main/core/legacyImport'
import type { LegacyModels } from '../../../src/shared/settings'

const legacy: LegacyModels = {
  llamaServerPath: 'D:\\llama\\llama-server.exe',
  modelsDir: 'D:\\Models',
  embeddingModel: 'nomic',
  idleUnloadMinutes: 30,
  options: { qwen: { args: '-c 8192 --jinja' }, gemma: { args: '-ngl 99' } },
  engine: 'cuda'
}
const engine: EngineSection = { path: 'D:\\llama\\llama-server.exe', build: 'cuda' }
const llamacpp: LlamacppSection = {
  modelsDir: 'D:\\Models',
  embeddingModel: 'nomic',
  idleUnloadMinutes: 30,
  options: { qwen: { args: '-c 8192 --jinja' }, gemma: { args: '-ngl 99' } }
}

const engineEntry = (rev: number, value: EngineSection = { path: null, build: 'bundled' }): EngineEntry => ({
  rev,
  value,
  effective: { path: 'C:\\app\\llama-server.exe' }
})
const llamacppEntry = (
  rev: number,
  value: LlamacppSection = { modelsDir: null, embeddingModel: null, idleUnloadMinutes: 15, options: {} }
): LlamacppEntry => ({ rev, value, effective: { modelsDir: 'C:\\Users\\me\\OpenVatra\\Models' } })

type Answer<E> = E | Error

/** A ConfigClient whose GETs and PUTs answer from per-section lists, in order; the PUT values are kept. */
function fakeClient(answers: {
  engineGet?: Answer<EngineEntry>
  enginePuts?: Answer<EngineEntry>[]
  llamacppGet?: Answer<LlamacppEntry>
  llamacppPuts?: Answer<LlamacppEntry>[]
}): { client: ConfigClient; enginePut: EngineSection[]; llamacppPut: LlamacppSection[] } {
  const enginePut: EngineSection[] = []
  const llamacppPut: LlamacppSection[] = []
  const settle = async <E>(answer: Answer<E> | undefined): Promise<E> => {
    if (answer === undefined) throw new Error('no answer left')
    if (answer instanceof Error) throw answer
    return answer
  }
  const enginePuts = [...(answers.enginePuts ?? [])]
  const llamacppPuts = [...(answers.llamacppPuts ?? [])]
  const client: ConfigClient = {
    getEngine: vi.fn(() => settle(answers.engineGet ?? engineEntry(0))),
    putEngine: vi.fn((_rev: number, value: EngineSection) => {
      enginePut.push(value)
      return settle(enginePuts.shift() ?? engineEntry(1, value))
    }),
    getLlamacpp: vi.fn(() => settle(answers.llamacppGet ?? llamacppEntry(0))),
    putLlamacpp: vi.fn((_rev: number, value: LlamacppSection) => {
      llamacppPut.push(value)
      return settle(llamacppPuts.shift() ?? llamacppEntry(1, value))
    }),
    setModelPath: vi.fn()
  }
  return { client, enginePut, llamacppPut }
}

const newLog = (): { [K in keyof ImportLog]: Mock<ImportLog[K]> } => ({
  info: vi.fn<ImportLog['info']>(),
  warn: vi.fn<ImportLog['warn']>(),
  error: vi.fn<ImportLog['error']>()
})

describe('splitLegacy', () => {
  it('turns a v6 value into the two sections, renaming llamaServerPath and engine', () => {
    expect(splitLegacy(legacy)).toEqual({ engine, llamacpp })
  })
})

describe('importLegacyModels', () => {
  it('imports both sections when core has never written them', async () => {
    const { client, enginePut, llamacppPut } = fakeClient({})
    const log = newLog()

    await expect(importLegacyModels(client, legacy, log)).resolves.toBe('imported')

    expect(enginePut).toEqual([engine])
    expect(llamacppPut).toEqual([llamacpp])
    expect(client.putEngine).toHaveBeenCalledWith(0, engine)
    expect(client.putLlamacpp).toHaveBeenCalledWith(0, llamacpp)
    expect(log.info).toHaveBeenCalledTimes(1)
    expect(log.info).toHaveBeenCalledWith('Model settings imported into core')
  })

  it('drops the old copy when core already has both sections', async () => {
    const { client, enginePut, llamacppPut } = fakeClient({
      engineGet: engineEntry(3),
      llamacppGet: llamacppEntry(2)
    })
    const log = newLog()

    await expect(importLegacyModels(client, legacy, log)).resolves.toBe('core-had-config')

    expect(enginePut).toEqual([])
    expect(llamacppPut).toEqual([])
    expect(log.info).toHaveBeenCalledWith(
      'Model settings: core already has them; dropped the old copy in settings.json'
    )
  })

  it('imports the provider section when only the engine section was written', async () => {
    const { client, enginePut, llamacppPut } = fakeClient({ engineGet: engineEntry(2) })
    const log = newLog()

    await expect(importLegacyModels(client, legacy, log)).resolves.toBe('imported')

    expect(enginePut).toEqual([])
    expect(llamacppPut).toEqual([llamacpp])
  })

  it('core wins a conflict on both sections', async () => {
    const conflict = (current: unknown): Error => new ConfigConflictError('changed', current)
    const { client } = fakeClient({
      enginePuts: [conflict(engineEntry(1))],
      llamacppPuts: [conflict(llamacppEntry(1))]
    })

    await expect(importLegacyModels(client, legacy, newLog())).resolves.toBe('conflict')
  })

  it('retries later when the provider GET fails, while the engine section is still imported', async () => {
    const { client, enginePut, llamacppPut } = fakeClient({ llamacppGet: new Error('core is not running') })
    const log = newLog()

    await expect(importLegacyModels(client, legacy, log)).resolves.toBe('retry-later')

    expect(enginePut).toEqual([engine])
    expect(llamacppPut).toEqual([])
    expect(log.info).toHaveBeenCalledWith('Model settings imported into core')
    expect(log.warn).toHaveBeenCalledWith('Model settings import postponed', expect.any(Error))
  })

  it('retries later when the database is unavailable', async () => {
    const unavailable = new ConfigUnavailableError('config storage is not available')
    const { client } = fakeClient({ enginePuts: [unavailable], llamacppPuts: [unavailable] })
    const log = newLog()

    await expect(importLegacyModels(client, legacy, log)).resolves.toBe('retry-later')
    expect(log.warn).toHaveBeenCalledTimes(1)
  })

  it('resets an invalid build to bundled and tries once more', async () => {
    const message = 'build must be "bundled" or "cuda"'
    const { client, enginePut } = fakeClient({ enginePuts: [new ConfigInvalidError(message)] })
    const log = newLog()

    await expect(importLegacyModels(client, legacy, log)).resolves.toBe('imported')

    expect(enginePut).toEqual([engine, { ...engine, build: 'bundled' }])
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining(message))
  })

  it.each([
    [
      'an option id',
      'options for "qwen": A quote " is not closed.',
      { ...llamacpp, options: { gemma: { args: '-ngl 99' } } }
    ],
    ['modelsDir', 'modelsDir must be an absolute path', { ...llamacpp, modelsDir: null }],
    [
      'idleUnloadMinutes',
      'idleUnloadMinutes must be between 1 and 1440',
      { ...llamacpp, idleUnloadMinutes: 15 }
    ]
  ])('drops or resets what core names (%s) and tries once more', async (_case, message, retried) => {
    const { client, llamacppPut } = fakeClient({ llamacppPuts: [new ConfigInvalidError(message)] })

    await expect(importLegacyModels(client, legacy, newLog())).resolves.toBe('imported')

    expect(llamacppPut).toEqual([llamacpp, retried])
  })

  it('gives up after a second refusal', async () => {
    const refused = (): Error => new ConfigInvalidError('build must be "bundled" or "cuda"')
    const { client, enginePut } = fakeClient({
      engineGet: engineEntry(0),
      llamacppGet: llamacppEntry(4),
      enginePuts: [refused(), refused()]
    })
    const log = newLog()

    await expect(importLegacyModels(client, legacy, log)).resolves.toBe('gave-up')

    expect(enginePut).toHaveLength(2)
    expect(log.error).toHaveBeenCalledWith(
      "Model settings could not be imported; using core's defaults",
      expect.any(Error)
    )
  })
})
