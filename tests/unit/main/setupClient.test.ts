// @vitest-environment node
import { describe, expect, it, vi, type Mock } from 'vitest'
import {
  createSetupClient,
  defaultModelsDir,
  isInside,
  type SetupClient
} from '../../../src/main/core/setupClient'
import type { ModelInfo } from '../../../src/shared/core'

const modelsDir = 'C:\\Users\\me\\OpenVatra\\Models'

describe('defaultModelsDir', () => {
  it('is OpenVatra\\Models under the user profile', () => {
    expect(defaultModelsDir('C:\\Users\\me')).toBe(modelsDir)
  })
})

describe('isInside', () => {
  it.each([
    ['a folder below it', modelsDir, `${modelsDir}\\qwen3-8b`, true],
    ['a different case (Windows ignores it)', modelsDir, 'c:\\users\\ME\\openvatra\\models\\qwen', true],
    ['forward slashes', modelsDir, 'C:/Users/me/OpenVatra/Models/qwen', true],
    ['the folder itself', modelsDir, modelsDir, false],
    ['its parent', modelsDir, 'C:\\Users\\me\\OpenVatra', false],
    ['a sibling with the same start', modelsDir, `${modelsDir}-old\\qwen`, false],
    ['a way out with ..', modelsDir, `${modelsDir}\\..\\..\\Documents`, false],
    ['another drive', modelsDir, 'D:\\Models\\qwen', false],
    ['a relative path', modelsDir, 'qwen', false]
  ])('%s', (_case, parent, child, expected) => {
    expect(isInside(parent, child)).toBe(expected)
  })
})

const model = (id: string, state: ModelInfo['state']): ModelInfo => ({
  id,
  state,
  busy: false,
  sizeBytes: 1,
  kind: 'chat'
})

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

/** A client over a fake core that answers the folder and catalog requests `remove` makes. */
function setUp(
  folder: unknown,
  models: () => ModelInfo[] = () => []
): {
  client: SetupClient
  request: Mock<(path: string) => Promise<Response>>
  trash: Mock
  unload: Mock
  makeDir: Mock
} {
  const request = vi.fn(async (path: string) => {
    if (path.endsWith('/folder')) return json({ folder })
    if (path === '/api/catalog')
      return json({ entries: [{ id: 'qwen3-8b', files: [{ name: 'Qwen3-8B-Q4.gguf' }] }] })
    return json({ status: 'accepted' }, 202)
  })
  const trash = vi.fn().mockResolvedValue(undefined)
  const unload = vi.fn().mockResolvedValue(undefined)
  const makeDir = vi.fn().mockResolvedValue(undefined)
  const client = createSetupClient({
    request,
    modelsDir: () => modelsDir,
    makeDir,
    trash,
    models,
    unload,
    pollMs: 1
  })
  return { client, request, trash, unload, makeDir }
}

describe('setup client: remove', () => {
  it('moves the model folder to the Recycle Bin', async () => {
    const { client, trash } = setUp(`${modelsDir}\\qwen3-8b`)

    await client.remove('qwen3-8b')

    expect(trash).toHaveBeenCalledWith(`${modelsDir}\\qwen3-8b`)
  })

  it.each([
    ['a path outside the models folder', 'C:\\Windows\\System32'],
    ['the models folder itself', modelsDir],
    ['a path that climbs out with ..', `${modelsDir}\\..\\..\\Documents`],
    ['something that is not a path', 42]
  ])('refuses %s and trashes nothing', async (_case, folder) => {
    const { client, trash, unload } = setUp(folder)

    await expect(client.remove('qwen3-8b')).rejects.toThrow('not inside the models folder')

    expect(trash).not.toHaveBeenCalled()
    expect(unload).not.toHaveBeenCalled()
  })

  it('unloads a loaded model and waits until it has stopped before trashing', async () => {
    let state: ModelInfo['state'] = 'ready'
    const { client, unload, trash } = setUp(`${modelsDir}\\qwen3-8b`, () => [
      model('Qwen3-8B-Q4', state),
      model('other', 'ready')
    ])
    unload.mockImplementation(async () => void setTimeout(() => (state = 'stopped'), 5))

    await client.remove('qwen3-8b')

    expect(unload).toHaveBeenCalledTimes(1)
    expect(unload).toHaveBeenCalledWith('Qwen3-8B-Q4')
    expect(trash).toHaveBeenCalledTimes(1)
  })

  it("shows core's own message when core refuses", async () => {
    const { client, request, trash } = setUp(null)
    request.mockResolvedValueOnce(
      json({ error: { code: 'unknown_model', message: 'not a catalog model' } }, 404)
    )

    await expect(client.remove('nope')).rejects.toThrow('not a catalog model')
    expect(trash).not.toHaveBeenCalled()
  })
})

describe('setup client: downloads', () => {
  it('creates the models folder, then queues the model', async () => {
    const { client, request, makeDir } = setUp(null)

    await client.download('qwen3-8b')

    expect(makeDir).toHaveBeenCalledWith(modelsDir)
    expect(request).toHaveBeenCalledWith(
      '/api/downloads',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ catalogId: 'qwen3-8b' }) })
    )
  })

  it('cancels and resumes by id, encoded into the path', async () => {
    const { client, request } = setUp(null)

    await client.cancel('a/b')
    await client.resume('qwen3-8b')

    expect(request).toHaveBeenCalledWith('/api/downloads/a%2Fb', { method: 'DELETE' })
    expect(request).toHaveBeenCalledWith('/api/downloads/qwen3-8b/resume', { method: 'POST' })
  })

  it("rejects with core's message, e.g. not enough space", async () => {
    const { client, request } = setUp(null)
    request.mockResolvedValueOnce(
      json({ error: { code: 'not_enough_space', message: 'not enough disk space' } }, 409)
    )

    await expect(client.download('qwen3-8b')).rejects.toThrow('not enough disk space')
  })
})

describe('setup client: reading core', () => {
  it('turns the catalog into what the UI needs, with the total size', async () => {
    const entry = {
      id: 'qwen3-8b',
      name: 'Qwen3 8B',
      summary: 'Good all-rounder',
      tags: ['chat'],
      licence: 'Apache-2.0',
      repo: 'x/y',
      files: [
        { name: 'a.gguf', sizeBytes: 100, sha256: 'x' },
        { name: 'b.gguf', sizeBytes: 50, sha256: 'y' }
      ],
      needsGB: 8,
      rank: 3,
      fit: 'fits',
      installed: false,
      diskShortBytes: 0
    }
    const { client, request } = setUp(null)
    request.mockResolvedValueOnce(json({ entries: [entry], diskFreeBytes: 1000, recommended: 'qwen3-8b' }))

    const view = await client.catalog()

    expect(view.recommended).toBe('qwen3-8b')
    expect(view.diskFreeBytes).toBe(1000)
    expect(view.entries[0]).toMatchObject({ id: 'qwen3-8b', sizeBytes: 150, fit: 'fits' })
    expect(view.entries[0]).not.toHaveProperty('files')
  })

  it('rejects a catalog or hardware report of the wrong shape', async () => {
    const { client, request } = setUp(null)
    request.mockResolvedValueOnce(json({ entries: [{ id: 1 }] }))
    request.mockResolvedValueOnce(json({ gpu: 'none' }))

    await expect(client.catalog()).rejects.toThrow('unreadable catalog')
    await expect(client.hardware()).rejects.toThrow('unreadable hardware')
  })

  it('reads a hardware report with and without a GPU', async () => {
    const { client, request } = setUp(null)
    request.mockResolvedValueOnce(json({ gpu: null, ramBytes: 16 }))

    await expect(client.hardware()).resolves.toEqual({ gpu: null, ramBytes: 16 })
  })
})
