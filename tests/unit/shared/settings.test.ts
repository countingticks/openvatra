// @vitest-environment node
import { describe, expect, it } from 'vitest'
import {
  defaultSettings,
  settingsPatchSchema,
  settingsSchema,
  settingsSchemaVersion
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
      closeToTrayNoticeShown: false
    })
  })

  it('cannot be changed by a caller', () => {
    expect(Object.isFrozen(defaultSettings)).toBe(true)
  })
})

describe('settingsSchema', () => {
  it('fills in defaults for missing fields', () => {
    expect(settingsSchema.parse({ schemaVersion: 1, theme: 'dark' })).toEqual({
      ...defaultSettings,
      theme: 'dark'
    })
  })

  it('accepts a complete, valid file', () => {
    const settings = {
      schemaVersion: 1,
      theme: 'light',
      startWithWindows: true,
      lastTab: 'code',
      closeAction: 'quit',
      sidebarOpen: false,
      window: { x: -1200, y: 40, width: 1280, height: 800 },
      closeToTrayNoticeShown: true
    }
    expect(settingsSchema.parse(settings)).toEqual(settings)
  })

  it('reads a file written before closeAction and sidebarOpen existed, with their defaults', () => {
    const older = { schemaVersion: 1, theme: 'dark', startWithWindows: true, lastTab: 'code' }

    expect(settingsSchema.parse(older)).toMatchObject({ closeAction: 'tray', sidebarOpen: true })
  })

  it('drops keys it does not know', () => {
    expect(settingsSchema.parse({ schemaVersion: 1, extra: 'ignored' })).toEqual(defaultSettings)
  })

  it.each([
    ['not an object', 'settings'],
    ['no schemaVersion', { theme: 'dark' }],
    ['a different schemaVersion', { schemaVersion: 2 }],
    ['an unknown theme', { schemaVersion: 1, theme: 'blue' }],
    ['a non-boolean startWithWindows', { schemaVersion: 1, startWithWindows: 'yes' }],
    ['an unknown tab', { schemaVersion: 1, lastTab: 'mail' }],
    ['an unknown close action', { schemaVersion: 1, closeAction: 'minimize' }],
    ['a non-boolean sidebarOpen', { schemaVersion: 1, sidebarOpen: 'open' }],
    [
      'a window smaller than the minimum',
      { schemaVersion: 1, window: { x: 0, y: 0, width: 400, height: 300 } }
    ],
    ['a window without a position', { schemaVersion: 1, window: { width: 1280, height: 800 } }]
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
      sidebarOpen: false
    }
    expect(settingsPatchSchema.parse(patch)).toEqual(patch)
  })

  it.each([
    ['not an object', null],
    ['schemaVersion', { schemaVersion: 1 }],
    ['window bounds', { window: { x: 0, y: 0, width: 1280, height: 800 } }],
    ['the close-to-tray notice flag', { closeToTrayNoticeShown: true }],
    ['an unknown key', { theme: 'dark', admin: true }],
    ['an invalid value', { theme: 'blue' }]
  ])('rejects %s', (_case, input) => {
    expect(settingsPatchSchema.safeParse(input).success).toBe(false)
  })
})
