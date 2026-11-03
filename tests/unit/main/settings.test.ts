// @vitest-environment node
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest'
import { loadSettings, logLoadOutcome, migrate, saveSettings } from '../../../src/main/settings'
import { defaultSettings, type Settings } from '../../../src/shared/settings'

const saved: Settings = { ...defaultSettings, theme: 'dark', lastTab: 'code' }

let dir: string
let filePath: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'openvatra-settings-'))
  filePath = join(dir, 'settings.json')
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('loadSettings', () => {
  it('uses defaults on first launch, when there is no file', async () => {
    expect(await loadSettings(filePath)).toEqual({ settings: defaultSettings, outcome: { kind: 'missing' } })
  })

  it('reads back what saveSettings wrote', async () => {
    await saveSettings(filePath, saved)
    expect(await loadSettings(filePath)).toEqual({ settings: saved, outcome: { kind: 'loaded' } })
  })

  it.each([
    ['corrupt', '{ "schemaVersion": 1, '],
    ['invalid', '{ "schemaVersion": 1, "theme": "blue" }']
  ] as const)('keeps a %s file as .bak and starts with defaults', async (reason, content) => {
    await writeFile(filePath, content)

    const result = await loadSettings(filePath)

    const backupPath = `${filePath}.bak`
    expect(result).toEqual({ settings: defaultSettings, outcome: { kind: 'recovered', reason, backupPath } })
    expect(await readFile(backupPath, 'utf8')).toBe(content)
    expect(await readdir(dir)).toEqual(['settings.json.bak'])
  })

  it('uses defaults but leaves the path alone when it cannot be read', async () => {
    await mkdir(filePath)

    const result = await loadSettings(filePath)

    expect(result.settings).toEqual(defaultSettings)
    expect(result.outcome.kind).toBe('unreadable')
    expect(await readdir(dir)).toEqual(['settings.json'])
  })

  it('returns a copy of the defaults that callers may change', async () => {
    const { settings } = await loadSettings(filePath)
    settings.theme = 'light'
    expect(defaultSettings.theme).toBe('system')
  })
})

describe('saveSettings', () => {
  it('replaces the file and leaves no temporary files behind', async () => {
    await saveSettings(filePath, saved)
    await saveSettings(filePath, { ...saved, theme: 'light' })

    expect(JSON.parse(await readFile(filePath, 'utf8'))).toEqual({ ...saved, theme: 'light' })
    expect(await readdir(dir)).toEqual(['settings.json'])
  })

  it('refuses invalid settings and keeps the old file', async () => {
    await saveSettings(filePath, saved)
    const invalid = { ...saved, theme: 'blue' } as unknown as Settings

    await expect(saveSettings(filePath, invalid)).rejects.toThrow()
    expect(JSON.parse(await readFile(filePath, 'utf8'))).toEqual(saved)
  })

  it('fails without leaving a temporary file when the folder is missing', async () => {
    await expect(saveSettings(join(dir, 'missing', 'settings.json'), saved)).rejects.toThrow()
    expect(await readdir(dir)).toEqual([])
  })
})

describe('migrate', () => {
  it('runs each step from the file version up to the current one', () => {
    const steps = { 0: (old: Record<string, unknown>) => ({ theme: old['colour'] }) }
    expect(migrate({ schemaVersion: 0, colour: 'dark' }, steps)).toEqual({ schemaVersion: 1, theme: 'dark' })
  })

  describe('1 → 2: Settings became a dialog', () => {
    it('reopens a file left on the Settings tab on Chat', () => {
      expect(migrate({ schemaVersion: 1, lastTab: 'settings', theme: 'dark' })).toEqual({
        schemaVersion: 4,
        lastTab: 'chat',
        theme: 'dark'
      })
    })

    it('keeps every other tab and setting as it was', () => {
      expect(migrate({ schemaVersion: 1, lastTab: 'code', closeAction: 'quit' })).toEqual({
        schemaVersion: 4,
        lastTab: 'code',
        closeAction: 'quit'
      })
    })

    it('loads a version-1 file from disk without setting it aside', async () => {
      await writeFile(filePath, JSON.stringify({ schemaVersion: 1, theme: 'dark', lastTab: 'settings' }))

      const { settings, outcome } = await loadSettings(filePath)

      expect(outcome).toEqual({ kind: 'loaded' })
      expect(settings).toMatchObject({ schemaVersion: 4, theme: 'dark', lastTab: 'chat' })
    })
  })

  describe('2 → 3: models settings', () => {
    it('keeps every existing setting and adds only the version', () => {
      expect(migrate({ schemaVersion: 2, theme: 'dark', lastTab: 'code' })).toEqual({
        schemaVersion: 4,
        theme: 'dark',
        lastTab: 'code'
      })
    })

    it('loads a real version-2 file with default models and nothing else changed', async () => {
      await writeFile(filePath, JSON.stringify({ schemaVersion: 2, theme: 'dark', closeAction: 'quit' }))

      const { settings, outcome } = await loadSettings(filePath)

      expect(outcome).toEqual({ kind: 'loaded' })
      expect(settings).toMatchObject({ schemaVersion: 4, theme: 'dark', closeAction: 'quit' })
      expect(settings.models).toEqual({
        llamaServerPath: null,
        modelsDir: null,
        embeddingModel: null,
        idleUnloadMinutes: 15,
        sharedArgs: '',
        options: {}
      })
    })

    it('upgrades a version-1 file through every step', () => {
      expect(migrate({ schemaVersion: 1, lastTab: 'settings' })).toEqual({
        schemaVersion: 4,
        lastTab: 'chat'
      })
    })
  })

  describe('3 → 4: options became argument text', () => {
    const v3 = (options: unknown): Record<string, unknown> => ({
      schemaVersion: 3,
      theme: 'dark',
      models: { modelsDir: 'D:/models', idleUnloadMinutes: 60, options }
    })

    it('turns the number fields and the argument list into one line per model', () => {
      expect(
        migrate(
          v3({
            qwen: { contextSize: 131072, gpuLayers: 0, extraArgs: ['--alias', 'my qwen'] },
            gemma: { extraArgs: ['--jinja'] },
            plain: {}
          })
        )
      ).toEqual({
        schemaVersion: 4,
        theme: 'dark',
        models: {
          modelsDir: 'D:/models',
          idleUnloadMinutes: 60,
          options: {
            qwen: { args: '-c 131072 -ngl 0 --alias "my qwen"' },
            gemma: { args: '--jinja' },
            plain: {}
          }
        }
      })
    })

    it("drops a model's arguments that name a flag core sets, instead of setting the file aside", async () => {
      await writeFile(
        filePath,
        JSON.stringify(v3({ qwen: { contextSize: 8192, extraArgs: ['--port', '1'] } }))
      )

      const { settings, outcome } = await loadSettings(filePath)

      expect(outcome).toEqual({ kind: 'loaded' })
      expect(settings.models).toMatchObject({ modelsDir: 'D:/models', sharedArgs: '', options: { qwen: {} } })
    })

    it('leaves a file without models alone', () => {
      expect(migrate({ schemaVersion: 3, theme: 'dark' })).toEqual({ schemaVersion: 4, theme: 'dark' })
    })
  })

  it.each([
    ['current files', { schemaVersion: 4, theme: 'dark' }],
    ['newer files', { schemaVersion: 5 }],
    ['files with no migration path', { schemaVersion: 0 }],
    ['non-objects', [1, 2]]
  ])('leaves %s unchanged', (_case, raw) => {
    expect(migrate(raw)).toEqual(raw)
  })
})

describe('logLoadOutcome', () => {
  const path = 'D:/data/settings.json'
  const fakeLogger = (): Record<'info' | 'warn' | 'error', Mock> => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  })

  it('logs a normal load and a first launch as info', () => {
    const logger = fakeLogger()
    logLoadOutcome(logger, path, { kind: 'loaded' })
    logLoadOutcome(logger, path, { kind: 'missing' })
    expect(logger.info).toHaveBeenCalledTimes(2)
    expect(logger.warn).not.toHaveBeenCalled()
    expect(logger.error).not.toHaveBeenCalled()
  })

  it('warns where the bad file was kept after a recovery', () => {
    const logger = fakeLogger()
    logLoadOutcome(logger, path, {
      kind: 'recovered',
      reason: 'corrupt',
      backupPath: 'D:/data/settings.json.bak'
    })
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('corrupt'))
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('D:/data/settings.json.bak'))
  })

  it('logs an unreadable file as an error, with the cause', () => {
    const logger = fakeLogger()
    const cause = new Error('EBUSY')
    logLoadOutcome(logger, path, { kind: 'unreadable', error: cause })
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining(path), cause)
  })
})
