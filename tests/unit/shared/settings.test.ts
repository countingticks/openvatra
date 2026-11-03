// @vitest-environment node
import { describe, expect, it } from 'vitest'
import {
  applyPatch,
  defaultSettings,
  settingsPatchSchema,
  settingsSchema,
  settingsSchemaVersion,
  type Settings
} from '../../../src/shared/settings'

describe('defaultSettings', () => {
  it('uses the documented defaults', () => {
    expect(defaultSettings).toEqual({
      schemaVersion: settingsSchemaVersion,
      theme: 'system',
      startWithWindows: false,
      lastTab: 'chat',
      closeAction: 'tray',
      sidebarOpen: true,
      motion: 'system',
      models: {
        llamaServerPath: null,
        modelsDir: null,
        embeddingModel: null,
        idleUnloadMinutes: 15,
        options: {}
      },
      closeToTrayNoticeShown: false
    })
  })

  it('cannot be changed by a caller', () => {
    expect(Object.isFrozen(defaultSettings)).toBe(true)
  })
})

describe('models settings', () => {
  const parse = (models: unknown): Settings => settingsSchema.parse({ schemaVersion: 3, models })

  it('has defaults, including an empty object for a file that has no models key', () => {
    expect(settingsSchema.parse({ schemaVersion: 3 }).models).toEqual(defaultSettings.models)
    expect(parse({}).models.idleUnloadMinutes).toBe(15)
  })

  it('accepts chosen paths, "never unload" and per-model options', () => {
    const models = {
      llamaServerPath: 'D:/llama/llama-server.exe',
      modelsDir: 'D:/models',
      embeddingModel: 'bge-m3',
      idleUnloadMinutes: null,
      options: { qwen: { contextSize: 8192, gpuLayers: 0, extraArgs: ['--flash-attn', 'on'] } }
    }
    expect(parse(models).models).toEqual(models)
  })

  it.each([
    ['an idle time that is not offered', { idleUnloadMinutes: 7 }],
    ['an empty path', { modelsDir: '' }],
    ['a negative gpuLayers', { options: { m: { gpuLayers: -1 } } }],
    ['extraArgs as one command string', { options: { m: { extraArgs: '--flash-attn on' } } }],
    ['an unknown option', { options: { m: { shell: 'cmd' } } }]
  ])('rejects %s', (_case, models) => {
    expect(settingsSchema.safeParse({ schemaVersion: 3, models }).success).toBe(false)
  })

  it('lets the UI change the embedding model, idle unload and options', () => {
    const patch = {
      models: { embeddingModel: 'nomic', idleUnloadMinutes: null, options: { qwen: { gpuLayers: 99 } } }
    }
    expect(settingsPatchSchema.parse(patch)).toEqual(patch)
    expect(settingsPatchSchema.parse({ models: {} })).toEqual({ models: {} })
  })

  it.each([
    ['llama-server.exe', { llamaServerPath: 'C:/evil.exe' }],
    ['the models folder', { modelsDir: 'C:/' }],
    ['an idle time not offered', { idleUnloadMinutes: 7 }],
    ['an empty model id', { options: { '': {} } }]
  ])("refuses %s from the UI (paths come only from main's file dialog)", (_case, models) => {
    expect(settingsPatchSchema.safeParse({ models }).success).toBe(false)
  })
})

describe('settingsSchema', () => {
  it('fills in defaults for missing fields', () => {
    expect(settingsSchema.parse({ schemaVersion: 3, theme: 'dark' })).toEqual({
      ...defaultSettings,
      theme: 'dark'
    })
  })

  it('accepts a complete, valid file', () => {
    const settings = {
      schemaVersion: 3,
      theme: 'light',
      startWithWindows: true,
      lastTab: 'code',
      closeAction: 'quit',
      sidebarOpen: false,
      motion: 'off',
      window: { x: -1200, y: 40, width: 1280, height: 800 },
      models: {
        llamaServerPath: 'D:/llama-server.exe',
        modelsDir: null,
        embeddingModel: 'bge',
        idleUnloadMinutes: 5,
        options: {}
      },
      closeToTrayNoticeShown: true
    }
    expect(settingsSchema.parse(settings)).toEqual(settings)
  })

  it('reads a file written before closeAction and sidebarOpen existed, with their defaults', () => {
    const older = { schemaVersion: 3, theme: 'dark', startWithWindows: true, lastTab: 'code' }

    expect(settingsSchema.parse(older)).toMatchObject({
      closeAction: 'tray',
      sidebarOpen: true,
      motion: 'system'
    })
  })

  it('drops keys it does not know', () => {
    expect(settingsSchema.parse({ schemaVersion: 3, extra: 'ignored' })).toEqual(defaultSettings)
  })

  it.each([
    ['not an object', 'settings'],
    ['no schemaVersion', { theme: 'dark' }],
    ['a different schemaVersion', { schemaVersion: 4 }],
    ['an unknown theme', { schemaVersion: 3, theme: 'blue' }],
    ['a non-boolean startWithWindows', { schemaVersion: 3, startWithWindows: 'yes' }],
    ['an unknown tab', { schemaVersion: 3, lastTab: 'mail' }],
    ['Settings as the last tab (a dialog since version 2)', { schemaVersion: 3, lastTab: 'settings' }],
    ['an unknown close action', { schemaVersion: 3, closeAction: 'minimize' }],
    ['a non-boolean sidebarOpen', { schemaVersion: 3, sidebarOpen: 'open' }],
    ['an unknown motion setting', { schemaVersion: 3, motion: 'slow' }],
    [
      'a window smaller than the minimum',
      { schemaVersion: 3, window: { x: 0, y: 0, width: 400, height: 300 } }
    ],
    ['a window without a position', { schemaVersion: 3, window: { width: 1280, height: 800 } }]
  ])('rejects %s', (_case, input) => {
    expect(settingsSchema.safeParse(input).success).toBe(false)
  })
})

describe('settingsPatchSchema', () => {
  it('accepts an empty patch without filling in defaults', () => {
    expect(settingsPatchSchema.parse({})).toEqual({})
  })

  it('accepts any of the keys the UI may change', () => {
    const patch = {
      theme: 'dark',
      startWithWindows: true,
      lastTab: 'automations',
      closeAction: 'quit',
      sidebarOpen: false,
      motion: 'on'
    }
    expect(settingsPatchSchema.parse(patch)).toEqual(patch)
  })

  it.each([
    ['not an object', null],
    ['schemaVersion', { schemaVersion: 3 }],
    ['window bounds', { window: { x: 0, y: 0, width: 1280, height: 800 } }],
    ['the close-to-tray notice flag', { closeToTrayNoticeShown: true }],
    ['an unknown key', { theme: 'dark', admin: true }],
    ['an invalid value', { theme: 'blue' }]
  ])('rejects %s', (_case, input) => {
    expect(settingsPatchSchema.safeParse(input).success).toBe(false)
  })
})

describe('applyPatch', () => {
  const chosen: Settings = {
    ...defaultSettings,
    models: {
      ...defaultSettings.models,
      llamaServerPath: 'C:/llama/llama-server.exe',
      modelsDir: 'D:/models'
    }
  }

  it('replaces top-level keys and leaves the rest', () => {
    expect(applyPatch(chosen, { theme: 'dark' })).toEqual({ ...chosen, theme: 'dark' })
  })

  it('merges models key by key, so the paths survive a change of embedding model', () => {
    expect(applyPatch(chosen, { models: { embeddingModel: 'nomic' } }).models).toEqual({
      ...chosen.models,
      embeddingModel: 'nomic'
    })
  })

  it('treats undefined as no change, at both levels', () => {
    expect(applyPatch(chosen, { theme: undefined, models: { idleUnloadMinutes: undefined } })).toEqual(chosen)
  })

  it('does not change the settings it was given', () => {
    const before = structuredClone(chosen)
    applyPatch(chosen, { theme: 'dark', models: { embeddingModel: 'nomic' } })
    expect(chosen).toEqual(before)
  })
})
