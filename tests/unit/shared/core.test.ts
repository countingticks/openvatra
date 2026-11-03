import { describe, expect, it } from 'vitest'
import { isCoreState } from '../../../src/shared/core'

describe('isCoreState', () => {
  it.each([
    { status: 'starting' },
    { status: 'ready', port: 53121, version: '0.1.0' },
    { status: 'problem', reason: 'core exited' }
  ])('accepts %j', (state) => expect(isCoreState(state)).toBe(true))

  it.each([
    null,
    'ready',
    {},
    { status: 'stopped' },
    { status: 'ready', port: '53121', version: '0.1.0' },
    { status: 'ready', port: 53121 },
    { status: 'problem' }
  ])('rejects %j', (value) => expect(isCoreState(value)).toBe(false))
})
