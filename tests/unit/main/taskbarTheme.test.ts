// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { parseRegDword } from '../../../src/main/taskbarTheme'

// What `reg query <key> /v SystemUsesLightTheme` prints on Windows (CRLF line endings).
const output = (value: string): string =>
  [
    '',
    'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize',
    `    SystemUsesLightTheme    REG_DWORD    ${value}`,
    '',
    ''
  ].join('\r\n')

describe('parseRegDword', () => {
  it('reads a light taskbar', () => {
    expect(parseRegDword(output('0x1'), 'SystemUsesLightTheme')).toBe(1)
  })

  it('reads a dark taskbar', () => {
    expect(parseRegDword(output('0x0'), 'SystemUsesLightTheme')).toBe(0)
  })

  it('reads hex values', () => {
    expect(parseRegDword(output('0x1f'), 'SystemUsesLightTheme')).toBe(31)
  })

  it('does not mistake a similarly named value for the one asked for', () => {
    expect(parseRegDword(output('0x1'), 'UsesLightTheme')).toBeUndefined()
  })

  it.each([
    ['empty output', ''],
    ['an error message', 'ERROR: The system was unable to find the specified registry key or value.']
  ])('returns undefined for %s', (_case, text) => {
    expect(parseRegDword(text, 'SystemUsesLightTheme')).toBeUndefined()
  })
})
