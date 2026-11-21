// Keeps a chat's cached transcript and chat entry current from core's events (APP-DESIGN 7): events past the
// snapshot's seq are applied, and events that arrive while a snapshot loads wait for it.
import type { Event } from '@app/core/generated'
import { coreApi } from '@app/core/coreApi'
import { coreEvent } from '@app/core/events'
import { rootReducer, type AppStartListening } from '@app/store/store'
import { liveSlice } from './liveSlice'
import { applyRunEvent, chatIdOf, runIdOf } from './runView'

export function registerRuns(startListening: AppStartListening): void {
  liveSlice.injectInto(rootReducer)
  // Per chat: the events that arrived while its transcript was loading, in arrival order.
  const held = new Map<string, Event[]>()

  startListening({
    actionCreator: coreEvent,
    effect: (action, api) => {
      const event = action.payload
      const chatId = chatIdOf(event)
      if (event.seq === undefined || chatId === null) return
      const arg = { id: chatId }

      const transcript = coreApi.endpoints.getTranscript.select(arg)(api.getState())
      if (transcript.status === 'pending') {
        // Loading or refetching: the snapshot on its way may or may not hold this event; decide when it lands.
        held.set(chatId, [...(held.get(chatId) ?? []), event])
      } else if (transcript.status === 'fulfilled' && transcript.data !== undefined) {
        const next = applyRunEvent(transcript.data, event)
        if (next !== transcript.data) {
          api.dispatch(coreApi.util.updateQueryData('getTranscript', arg, () => next))
        }
      }
      // Nothing cached: opening the chat fetches it whole.

      const chat = coreApi.endpoints.getChat.select(arg)(api.getState()).data
      if (chat === undefined || event.seq <= chat.seq) return
      const seq = event.seq
      const runId = runIdOf(event)
      api.dispatch(
        coreApi.util.updateQueryData('getChat', arg, (draft) => {
          draft.seq = seq
          const active = draft.chat.activeRun
          switch (event.type) {
            case 'chat.model':
              draft.chat.model = event.data.model
              return
            case 'run.queued':
              if (runId !== null) draft.chat.activeRun = { id: runId, state: 'queued' }
              return
            case 'run.started':
            case 'run.resumed':
              if (active && active.id === runId) active.state = 'running'
              return
            case 'run.paused':
              if (active && active.id === runId) active.state = 'interrupted'
              return
            case 'run.finished':
              if (active && active.id === runId) draft.chat.activeRun = null
              return
          }
        })
      )
    }
  })

  startListening({
    matcher: coreApi.endpoints.getTranscript.matchFulfilled,
    effect: (action, api) => {
      const arg = { id: action.meta.arg.originalArgs.id }
      const events = held.get(arg.id)
      if (events === undefined) return
      held.delete(arg.id)
      const data = coreApi.endpoints.getTranscript.select(arg)(api.getState()).data
      if (data === undefined) return
      // Each is still seq-gated: those the new snapshot already holds change nothing.
      const next = events.reduce(applyRunEvent, data)
      if (next !== data) api.dispatch(coreApi.util.updateQueryData('getTranscript', arg, () => next))
    }
  })

  startListening({
    matcher: coreApi.endpoints.getTranscript.matchRejected,
    effect: (action) => {
      // A request skipped because one is already on its way is not the answer the held events wait for.
      if (action.meta.condition) return
      held.delete(action.meta.arg.originalArgs.id)
    }
  })
}
