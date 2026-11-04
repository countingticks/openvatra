// @vitest-environment node
import { mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  bundledLlamaDir,
  bundledLlamaExe,
  llamaManifestPath,
  readBundledTag
} from '../../../src/main/bundledLlama'

describe('bundled llama.cpp location', () => {
  it('is beside app.asar when installed, and in resources/llama/bin in development', () => {
    expect(bundledLlamaDir(true, 'C:/Apps/OpenVatra/resources', 'C:/Apps/OpenVatra/resources/app.asar')).toBe(
      join('C:/Apps/OpenVatra/resources', 'llama')
    )
    expect(bundledLlamaDir(false, 'C:/electron/resources', 'D:/Repos/openvatra')).toBe(
      join('D:/Repos/openvatra', 'resources', 'llama', 'bin')
    )
  })

  it('finds llama.json next to the bundled build, which is not inside bin/ in development', () => {
    expect(llamaManifestPath(true, 'C:/Apps/OpenVatra/resources', 'unused')).toBe(
      join('C:/Apps/OpenVatra/resources', 'llama', 'llama.json')
    )
    expect(llamaManifestPath(false, 'unused', 'D:/Repos/openvatra')).toBe(
      join('D:/Repos/openvatra', 'resources', 'llama', 'llama.json')
    )
  })

  it('names llama-server.exe inside that folder', () => {
    expect(bundledLlamaExe('D:/x')).toBe(join('D:/x', 'llama-server.exe'))
  })
})

describe('readBundledTag', () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'openvatra-llama-'))
  })
  afterEach(() => rm(dir, { recursive: true, force: true }))

  it('reads the release tag the fetch script wrote', async () => {
    await writeFile(join(dir, '.tag'), 'b12078\n')
    expect(await readBundledTag(dir)).toBe('b12078')
  })

  it('is null when there is no usable .tag file', async () => {
    expect(await readBundledTag(dir)).toBeNull()
    await writeFile(join(dir, '.tag'), '  \n')
    expect(await readBundledTag(dir)).toBeNull()
  })
})
