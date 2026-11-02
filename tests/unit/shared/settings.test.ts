// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { defaultSettings, settingsSchema, settingsSchemaVersion } from '../../../src/shared/settings'

describe('defaultSettings', () => {
  it('uses the documented defaults', () => {
    expect(defaultSettings).toEqual({
      schemaVersion: settingsSchemaVersion,
      theme: 'system',
      startWithWindows: false,
      lastTab: 'chat'
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
      window: { x: -1200, y: 40, width: 1280, height: 800 }
    }
    expect(settingsSchema.parse(settings)).toEqual(settings)
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
    [
      'a window smaller than the minimum',
      { schemaVersion: 1, window: { x: 0, y: 0, width: 400, height: 300 } }
    ],
    ['a window without a position', { schemaVersion: 1, window: { width: 1280, height: 800 } }]
  ])('rejects %s', (_case, input) => {
    expect(settingsSchema.safeParse(input).success).toBe(false)
  })
})
