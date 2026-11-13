import { describe, expect, it } from 'vitest'
import { isCoreState } from '../../../src/shared/core'

describe('isCoreState', () => {
  const connection = { baseUrl: 'http://127.0.0.1:53121', token: 'a'.repeat(64) }

  it.each([
    { status: 'starting' },
    { status: 'ready', port: 53121, version: '0.1.0', connection },
    { status: 'problem', reason: 'core exited' }
  ])('accepts %j', (state) => expect(isCoreState(state)).toBe(true))

  it.each([
    null,
    'ready',
    {},
    { status: 'stopped' },
    { status: 'ready', port: '53121', version: '0.1.0' },
    { status: 'ready', port: 53121 },
    { status: 'ready', port: 53121, version: '0.1.0' },
    {
      status: 'ready',
      port: 53121,
      version: '0.1.0',
      connection: { ...connection, baseUrl: 'http://10.0.0.5:53121' }
    },
    { status: 'ready', port: 53121, version: '0.1.0', connection: { ...connection, token: 'a'.repeat(32) } },
    { status: 'problem' }
  ])('rejects %j', (value) => expect(isCoreState(value)).toBe(false))
})
