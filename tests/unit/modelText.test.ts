import { describe, expect, it } from 'vitest'
import { failureReason } from '@renderer/lib/modelText'

describe('failureReason', () => {
  it.each([
    [
      "core's message from its error body",
      { status: 409, data: { error: 'not_enough_space', message: 'Not enough free space.' } },
      'Not enough free space.'
    ],
    ['no connection to core', { status: 'CORE_UNAVAILABLE' }, 'The models service is not running'],
    [
      'a failed fetch',
      { status: 'FETCH_ERROR', error: 'TypeError: Failed to fetch' },
      'Could not reach the models service'
    ],
    [
      "an IPC error, without Electron's prefix",
      new Error("Error invoking remote method 'files:pick': Error: disk full"),
      'disk full'
    ],
    ['a plain string', 'something broke', 'something broke']
  ])('%s', (_case, error, expected) => {
    expect(failureReason(error)).toBe(expected)
  })
})
