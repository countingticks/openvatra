// @vitest-environment node
import { describe, expect, it } from 'vitest'
import {
  applyPatch,
  defaultSettings,
  defaultSettingsFile,
  settingsFileSchema,
  settingsPatchSchema,
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
      showAdvancedModels: false,
      cudaOfferDismissed: false,
      closeToTrayNoticeShown: false
    })
  })

  it('cannot be changed by a caller', () => {
    expect(Object.isFrozen(defaultSettings)).toBe(true)
  })
})

describe('settingsFileSchema', () => {
  it('fills in the file defaults: the view flags at the top level, no models and no legacyModels', () => {
    expect(settingsFileSchema.parse({ schemaVersion: 7 })).toEqual({
      schemaVersion: 7,
      theme: 'system',
      startWithWindows: false,
      lastTab: 'chat',
      closeAction: 'tray',
      sidebarOpen: true,
      motion: 'system',
      closeToTrayNoticeShown: false,
      showAdvancedModels: false,
      cudaOfferDismissed: false
    })
    expect(defaultSettingsFile).toEqual(settingsFileSchema.parse({ schemaVersion: 7 }))
    expect(Object.isFrozen(defaultSettingsFile)).toBe(true)
  })

  it('fills the keys legacyModels leaves out with the v6 defaults', () => {
    expect(
      settingsFileSchema.parse({ schemaVersion: 7, legacyModels: { modelsDir: 'D:/models' } }).legacyModels
    ).toEqual({
      llamaServerPath: null,
      modelsDir: 'D:/models',
      embeddingModel: null,
      idleUnloadMinutes: 15,
      options: {},
      engine: 'bundled'
    })
  })
})

describe('the window settings', () => {
  it('has the two model view flags and no models', () => {
    expect(defaultSettings).toMatchObject({ showAdvancedModels: false, cudaOfferDismissed: false })
    expect(defaultSettings).not.toHaveProperty('models')
  })

  it.each([
    ['an idle time that is not offered', { idleUnloadMinutes: 7 }],
    ['an empty path', { modelsDir: '' }],
    ['an unknown engine', { engine: 'rocm' }],
    ['arguments with an unclosed quote', { options: { m: { args: '--alias "my qwen' } } }],
    ['an unknown option', { options: { m: { shell: 'cmd' } } }]
  ])('legacyModels rejects %s', (_case, models) => {
    expect(settingsFileSchema.safeParse({ schemaVersion: 7, legacyModels: models }).success).toBe(false)
  })

  it('the patch schema accepts the two flags and rejects models', () => {
    expect(
      settingsPatchSchema.safeParse({ showAdvancedModels: true, cudaOfferDismissed: true }).success
    ).toBe(true)
    expect(settingsPatchSchema.safeParse({ models: { engine: 'cuda' } }).success).toBe(false)
  })
})

describe('settingsPatchSchema', () => {
  it.each([
    ['not an object', null],
    ['schemaVersion', { schemaVersion: 7 }],
    ['window bounds', { window: { x: 0, y: 0, width: 1280, height: 800 } }],
    ['the close-to-tray notice flag', { closeToTrayNoticeShown: true }],
    ['an unknown key', { theme: 'dark', admin: true }],
    ['an invalid value', { theme: 'blue' }]
  ])('rejects %s', (_case, input) => {
    expect(settingsPatchSchema.safeParse(input).success).toBe(false)
  })
})

describe('applyPatch', () => {
  const chosen: Settings = { ...defaultSettings, theme: 'light', showAdvancedModels: true }

  it('replaces top-level keys and leaves the rest', () => {
    expect(applyPatch(chosen, { theme: 'dark', cudaOfferDismissed: true })).toEqual({
      ...chosen,
      theme: 'dark',
      cudaOfferDismissed: true
    })
  })

  it('treats undefined as no change', () => {
    expect(applyPatch(chosen, { theme: undefined, showAdvancedModels: undefined })).toEqual(chosen)
  })

  it('does not change the settings it was given', () => {
    const before = structuredClone(chosen)
    applyPatch(chosen, { theme: 'dark' })
    expect(chosen).toEqual(before)
  })
})
