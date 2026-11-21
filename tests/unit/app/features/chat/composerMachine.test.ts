import { describe, expect, it } from 'vitest'
import {
  composerReducer,
  sendErrorMessage,
  type ComposerEvent,
  type ComposerState
} from '@app/features/chat/composerMachine'

const idle: ComposerState = { status: 'idle' }
const run = (...events: ComposerEvent[]): ComposerState => events.reduce(composerReducer, idle)

describe('composerReducer', () => {
  it('goes from sending back to idle once sent', () => {
    expect(run({ type: 'send', requestId: 'a' })).toEqual({ status: 'sending', requestId: 'a' })
    expect(run({ type: 'send', requestId: 'a' }, { type: 'sent' })).toEqual(idle)
  })

  it('reuses the failed request id when sending again unedited', () => {
    const failed = run({ type: 'send', requestId: 'a' }, { type: 'failed', message: 'busy' })

    expect(failed).toEqual({ status: 'failed', requestId: 'a', message: 'busy' })
    expect(composerReducer(failed, { type: 'send', requestId: 'b' })).toEqual({
      status: 'sending',
      requestId: 'a'
    })
  })

  it('uses the new id after the failed text was edited', () => {
    const state = run(
      { type: 'send', requestId: 'a' },
      { type: 'failed', message: 'busy' },
      { type: 'edited' },
      { type: 'send', requestId: 'b' }
    )

    expect(state).toEqual({ status: 'sending', requestId: 'b' })
  })

  it('ignores a second send while sending', () => {
    expect(run({ type: 'send', requestId: 'a' }, { type: 'send', requestId: 'b' })).toEqual({
      status: 'sending',
      requestId: 'a'
    })
  })
})

describe('sendErrorMessage', () => {
  it("is core's message for a core error body", () => {
    expect(
      sendErrorMessage({ status: 409, data: { error: 'chat_busy', message: 'The chat is busy.' } })
    ).toBe('The chat is busy.')
  })

  it('is a generic sentence for a network error', () => {
    expect(sendErrorMessage({ status: 'FETCH_ERROR', error: 'TypeError: Failed to fetch' })).toBe(
      "Couldn't reach OpenVatra's core. Try again."
    )
  })
})
