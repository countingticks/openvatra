// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { coreErrorMessage } from '../../../src/main/core/coreError'

describe('coreErrorMessage', () => {
  it("returns core's message from the flat error body", async () => {
    const response = Response.json(
      { error: 'load_failed', message: 'llama-server.exe not found' },
      { status: 503 }
    )

    await expect(coreErrorMessage(response)).resolves.toBe('llama-server.exe not found')
  })

  it('cuts a long message to 300 characters', async () => {
    const response = Response.json({ error: 'x', message: 'a'.repeat(400) }, { status: 400 })

    await expect(coreErrorMessage(response)).resolves.toBe('a'.repeat(300))
  })

  it('falls back to the HTTP status for a body that is not JSON', async () => {
    await expect(coreErrorMessage(new Response('oops', { status: 500 }))).resolves.toBe(
      'core answered with HTTP 500'
    )
  })

  it.each([
    ['missing', { error: 'x' }],
    ['empty', { error: 'x', message: '' }],
    ['not a string', { error: 'x', message: 42 }],
    ['the old nested shape', { error: { code: 'x', message: 'nested' } }],
    ['null', null]
  ])('falls back to the HTTP status when message is missing or empty (%s)', async (_case, body) => {
    await expect(coreErrorMessage(Response.json(body, { status: 409 }))).resolves.toBe(
      'core answered with HTTP 409'
    )
  })
})
