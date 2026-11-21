// The message box's send cycle (APP-DESIGN 8): idle → sending → idle on success, or failed with core's sentence.
// A retry of unedited text reuses the failed request id, so core answers it with the same run (decision 13).

export type ComposerState =
  | { status: 'idle' }
  | { status: 'sending'; requestId: string }
  | { status: 'failed'; requestId: string; message: string }

export type ComposerEvent =
  | { type: 'send'; requestId: string }
  | { type: 'sent' }
  | { type: 'failed'; message: string }
  | { type: 'edited' }

export function composerReducer(state: ComposerState, event: ComposerEvent): ComposerState {
  switch (event.type) {
    case 'send':
      if (state.status === 'sending') return state
      // Still failed means the text was not edited since (an edit moves back to idle): the same request again.
      return { status: 'sending', requestId: state.status === 'failed' ? state.requestId : event.requestId }
    case 'sent':
      return { status: 'idle' }
    case 'failed':
      return state.status === 'idle'
        ? state
        : { status: 'failed', requestId: state.requestId, message: event.message }
    case 'edited':
      return state.status === 'failed' ? { status: 'idle' } : state
  }
}

/** core's own sentence for a failed send (its `{ error, message }` body), else a generic one. */
export function sendErrorMessage(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'data' in error) {
    const { data } = error as { data?: { message?: unknown } }
    if (typeof data === 'object' && data !== null && typeof data.message === 'string') return data.message
  }
  return "Couldn't reach OpenVatra's core. Try again."
}
