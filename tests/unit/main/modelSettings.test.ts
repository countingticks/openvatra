// @vitest-environment node
import { describe, expect, it, type Mock, vi } from 'vitest'
import { createConfigClient, type CoreModels, type ModelsEntry } from '../../../src/main/core/configClient'
import { createModelSettings, type ModelSettings } from '../../../src/main/core/modelSettings'

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
const effective = {
  llamaServerPath: 'C:\\app\\llama-server.exe',
  modelsDir: 'C:\\Users\\me\\OpenVatra\\Models'
}

interface FakeCore {
  request: Mock<Request>
  puts: { rev: number; value: CoreModels }[]
  /** Answers sent before the fake's own, one per request. */
  answers: Response[]
  stored: () => ModelsEntry
  /** Someone else (core's engine switch, another client) writes the section. */
  write: (change: Partial<CoreModels>) => void
}

/** A fake core holding the `models` section: PUT checks the rev like the real one. */
function fakeCore(rev = 0, value: CoreModels = defaults): FakeCore {
  let stored: ModelsEntry = { rev, value, effective }
  const answers: Response[] = []
  const puts: { rev: number; value: CoreModels }[] = []
  const request = vi.fn<Request>(async (_path, init) => {
    const answer = answers.shift()
    if (init?.method === 'PUT') puts.push(JSON.parse(init.body as string) as (typeof puts)[number])
    if (answer) return answer
    if (init?.method !== 'PUT') return json(stored)
    const body = puts[puts.length - 1]
    if (body.rev !== stored.rev) {
      return json(
        { error: 'config_conflict', message: 'the section changed since it was read', current: stored },
        409
      )
    }
    stored = { rev: stored.rev + 1, value: body.value, effective }
    return json(stored)
  })
  return {
    request,
    puts,
    answers,
    stored: () => stored,
    write: (change: Partial<CoreModels>) => {
      stored = { rev: stored.rev + 1, value: { ...stored.value, ...change }, effective }
    }
  }
}

function setUp(core = fakeCore(), ready = true): { settings: ModelSettings; core: FakeCore; warn: Mock } {
  const warn = vi.fn()
  const settings = createModelSettings({
    client: createConfigClient(core.request),
    isReady: () => ready,
    log: { warn }
  })
  return { settings, core, warn }
}

describe('model settings', () => {
  it('entry is null until core answered', async () => {
    const { settings } = setUp(fakeCore(2))

    expect(settings.entry()).toBeNull()
    await settings.refresh()

    expect(settings.entry()).toEqual({ rev: 2, value: defaults, effective })
  })

  it('update merges the change and PUTs the whole section with the cached rev', async () => {
    const { settings, core } = setUp(fakeCore(2, { ...defaults, modelsDir: 'D:\\Models' }))
    await settings.refresh()

    const entry = await settings.update({ embeddingModel: 'nomic', idleUnloadMinutes: undefined })

    expect(core.puts).toEqual([
      { rev: 2, value: { ...defaults, modelsDir: 'D:\\Models', embeddingModel: 'nomic' } }
    ])
    expect(entry.rev).toBe(3)
    expect(settings.entry()).toEqual(entry)
  })

  it('update reads first when nothing is cached yet', async () => {
    const { settings, core } = setUp(fakeCore(4))

    await settings.update({ engine: 'cuda' })

    expect(core.request.mock.calls.map(([, init]) => init?.method ?? 'GET')).toEqual(['GET', 'PUT'])
    expect(core.puts).toEqual([{ rev: 4, value: { ...defaults, engine: 'cuda' } }])
  })

  it('update rejects while core is not ready, without a request', async () => {
    const { settings, core } = setUp(fakeCore(), false)

    await expect(settings.update({ engine: 'cuda' })).rejects.toThrow('The models service is not running')
    expect(core.request).not.toHaveBeenCalled()
  })

  it("a conflict takes core's entry, re-applies the change and retries once", async () => {
    const { settings, core } = setUp(fakeCore(1))
    await settings.refresh()
    core.write({ engine: 'cuda' })

    const entry = await settings.update({ embeddingModel: 'nomic' })

    expect(core.puts.map((put) => put.rev)).toEqual([1, 2])
    expect(entry).toEqual({
      rev: 3,
      value: { ...defaults, engine: 'cuda', embeddingModel: 'nomic' },
      effective
    })
    expect(settings.entry()).toEqual(entry)
  })

  it('a second conflict rejects', async () => {
    const { settings, core } = setUp(fakeCore(1))
    await settings.refresh()
    const conflict = (rev: number): Response =>
      json(
        {
          error: 'config_conflict',
          message: 'the section changed since it was read',
          current: { rev, value: defaults, effective }
        },
        409
      )
    core.answers.push(conflict(2), conflict(3))

    await expect(settings.update({ embeddingModel: 'nomic' })).rejects.toThrow(
      'the section changed since it was read'
    )
    expect(core.puts).toHaveLength(2)
  })

  it("an invalid change rejects with core's message and keeps the cache", async () => {
    const { settings, core } = setUp(fakeCore(1))
    const before = await settings.refresh()
    core.answers.push(json({ error: 'invalid_config', message: 'options for "qwen": unclosed quote' }, 400))

    await expect(settings.update({ options: { qwen: { args: '"' } } })).rejects.toThrow(
      'options for "qwen": unclosed quote'
    )
    expect(settings.entry()).toEqual(before)
  })

  it('two quick updates PUT one after another with increasing revs', async () => {
    const { settings, core } = setUp(fakeCore(1))
    await settings.refresh()

    await Promise.all([
      settings.update({ embeddingModel: 'nomic' }),
      settings.update({ idleUnloadMinutes: 30 })
    ])

    expect(core.puts.map((put) => put.rev)).toEqual([1, 2])
    expect(core.stored()).toEqual({
      rev: 3,
      value: { ...defaults, embeddingModel: 'nomic', idleUnloadMinutes: 30 },
      effective
    })
  })

  it('a config event past the cached rev refreshes; one at or below it does not; another section does not', async () => {
    const { settings, core } = setUp(fakeCore(2))
    await settings.refresh()
    core.request.mockClear()

    settings.noteChanged('models', 2)
    settings.noteChanged('models', 1)
    settings.noteChanged('chats', 9)
    await Promise.resolve()
    expect(core.request).not.toHaveBeenCalled()

    core.write({ engine: 'cuda' })
    settings.noteChanged('models', 3)

    await vi.waitFor(() => expect(settings.entry()?.rev).toBe(3))
    expect(settings.entry()?.value.engine).toBe('cuda')
    expect(core.request).toHaveBeenCalledTimes(1)
  })

  it('a failed refresh after a config event is logged', async () => {
    const { settings, core, warn } = setUp(fakeCore(2))
    await settings.refresh()
    core.request.mockRejectedValueOnce(new Error('core is not running'))

    settings.noteChanged('models', 3)

    await vi.waitFor(() =>
      expect(warn).toHaveBeenCalledWith('Could not read the model settings from core', expect.any(Error))
    )
  })

  it('listeners hear a changed entry, not an unchanged refresh', async () => {
    const { settings, core } = setUp(fakeCore(1))
    await settings.refresh()
    const listener = vi.fn()
    settings.onChange(listener)

    await settings.refresh()
    expect(listener).not.toHaveBeenCalled()

    core.write({ idleUnloadMinutes: 60 })
    await settings.refresh()
    expect(listener).toHaveBeenCalledTimes(1)
    expect(listener).toHaveBeenCalledWith(core.stored())
  })
})
