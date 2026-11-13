// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { devServerOrigin, isAppUrl, isExternalWebUrl } from '../../../src/main/urlPolicy'

describe('devServerOrigin', () => {
  it('gives the dev server URL its origin without the path', () => {
    expect(devServerOrigin('http://localhost:5173/')).toBe('http://localhost:5173')
  })

  it('gives null for the bundled index.html', () => {
    expect(
      devServerOrigin('file:///C:/Program%20Files/OpenVatra/resources/app.asar/out/renderer/index.html')
    ).toBe(null)
  })
})

describe('isExternalWebUrl', () => {
  it.each(['https://github.com/countingticks/openvatra', 'http://example.com/page?q=1'])(
    'allows web link %s',
    (url) => {
      expect(isExternalWebUrl(url)).toBe(true)
    }
  )

  it.each([
    'file:///C:/Windows/System32/calc.exe',
    'javascript:alert(1)',
    'ms-settings:privacy',
    'smb://attacker/share',
    'data:text/html,<script>alert(1)</script>',
    'not a url'
  ])('refuses %s', (url) => {
    expect(isExternalWebUrl(url)).toBe(false)
  })
})

describe('isAppUrl', () => {
  const prod = 'file:///C:/Program%20Files/OpenVatra/resources/app.asar/out/renderer/index.html'
  const dev = 'http://localhost:5173/'

  it('accepts the bundled index.html, with or without a hash', () => {
    expect(isAppUrl(prod, prod)).toBe(true)
    expect(isAppUrl(`${prod}#/settings`, prod)).toBe(true)
  })

  it('refuses any other local file', () => {
    expect(isAppUrl('file:///C:/Users/me/Downloads/evil.html', prod)).toBe(false)
  })

  it('accepts pages from the dev server origin only', () => {
    expect(isAppUrl('http://localhost:5173/src/main.tsx', dev)).toBe(true)
    expect(isAppUrl('http://localhost:8080/', dev)).toBe(false)
    expect(isAppUrl('https://localhost:5173/', dev)).toBe(false)
  })

  it('refuses remote sites and invalid input', () => {
    expect(isAppUrl('https://evil.example/', prod)).toBe(false)
    expect(isAppUrl('https://evil.example/', dev)).toBe(false)
    expect(isAppUrl('not a url', dev)).toBe(false)
  })
})
