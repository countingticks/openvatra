// Keeps the sidebar's chat list current from core's events, the way runs/sync.ts keeps a transcript: events past the
// list's seq are applied, and events that arrive while the list loads wait for it.
import type { ChatList, Event } from '@app/core/generated'
import { coreApi } from '@app/core/coreApi'
import { coreEvent } from '@app/core/events'
import { chatIdOf, runIdOf } from '@app/features/runs'
import type { AppDispatch, AppStartListening } from '@app/store/store'

// The full list; a search (q) is a separate entry the events don't patch.
const listArg = {}

/** The list with the event applied, and whether the event names a chat the list doesn't have yet. */
function applyListEvent(list: ChatList, event: Event): { list: ChatList; missing: boolean } {
  const chatId = chatIdOf(event)
  if (event.seq === undefined || event.seq <= list.seq) return { list, missing: false }
  const next: ChatList = { seq: event.seq, chats: list.chats }
  const index = list.chats.findIndex((chat) => chat.id === chatId)
  if (index === -1) {
    return { list: next, missing: event.type === 'run.queued' || event.type === 'input.received' }
  }
  const chat = list.chats[index]!
  const runId = runIdOf(event)
  const active = chat.activeRun
  const replace = (changed: typeof chat): ChatList => ({
    ...next,
    chats: list.chats.map((item, i) => (i === index ? changed : item))
  })
  const toTop = (changed: typeof chat): ChatList => ({
    ...next,
    chats: [changed, ...list.chats.filter((_, i) => i !== index)]
  })
  switch (event.type) {
    case 'run.queued':
      return {
        list: runId === null ? next : replace({ ...chat, activeRun: { id: runId, state: 'queued' } }),
        missing: false
      }
    case 'run.started':
    case 'run.resumed':
      return {
        list:
          active && active.id === runId
            ? replace({ ...chat, activeRun: { ...active, state: 'running' } })
            : next,
        missing: false
      }
    case 'run.paused':
      return {
        list:
          active && active.id === runId
            ? replace({ ...chat, activeRun: { ...active, state: 'interrupted' } })
            : next,
        missing: false
      }
    case 'input.received':
      return { list: toTop({ ...chat, updatedAt: event.time }), missing: false }
    case 'run.finished':
      return {
        list: toTop({
          ...chat,
          updatedAt: event.time,
          activeRun: active && active.id === runId ? null : active
        }),
        missing: false
      }
    case 'chat.titled':
      // A model-made title never replaces one the user chose.
      if (event.data.source === 'auto' && chat.titleSource === 'user') return { list: next, missing: false }
      return {
        list: replace({ ...chat, title: event.data.title, titleSource: event.data.source }),
        missing: false
      }
    case 'chat.model':
      return { list: replace({ ...chat, model: event.data.model }), missing: false }
    case 'chat.deleted':
      return { list: { ...next, chats: list.chats.filter((_, i) => i !== index) }, missing: false }
    default:
      return { list: next, missing: false }
  }
}

function refetch(dispatch: AppDispatch): void {
  void dispatch(coreApi.endpoints.listChats.initiate(listArg, { subscribe: false, forceRefetch: true }))
}

function apply(events: Event[], list: ChatList, dispatch: AppDispatch): void {
  let next = list
  let missing = false
  for (const event of events) {
    const applied = applyListEvent(next, event)
    next = applied.list
    missing ||= applied.missing
  }
  if (next !== list) dispatch(coreApi.util.updateQueryData('listChats', listArg, () => next))
  // One refetch brings in every chat the list didn't have.
  if (missing) refetch(dispatch)
}

const isFullList = (arg: { q?: string }): boolean => arg.q === undefined

export function registerChatList(startListening: AppStartListening): void {
  // The events that arrived while the list was loading, in arrival order.
  let held: Event[] = []

  startListening({
    actionCreator: coreEvent,
    effect: (action, api) => {
      const event = action.payload
      if (event.seq === undefined) return
      const entry = coreApi.endpoints.listChats.select(listArg)(api.getState())
      if (entry.status === 'pending') {
        // The list on its way may or may not hold this event; decide when it lands.
        held.push(event)
      } else if (entry.status === 'fulfilled' && entry.data !== undefined) {
        apply([event], entry.data, api.dispatch)
      }
      // No list: the sidebar fetches it whole when it shows.
    }
  })

  startListening({
    matcher: coreApi.endpoints.listChats.matchFulfilled,
    effect: (action, api) => {
      if (!isFullList(action.meta.arg.originalArgs)) return
      const events = held
      held = []
      const data = coreApi.endpoints.listChats.select(listArg)(api.getState()).data
      if (events.length === 0 || data === undefined) return
      // Each is still seq-gated: those the new list already holds change nothing.
      apply(events, data, api.dispatch)
    }
  })

  startListening({
    matcher: coreApi.endpoints.listChats.matchRejected,
    effect: (action) => {
      // A request skipped because one is already on its way is not the answer the held events wait for.
      if (action.meta.condition || !isFullList(action.meta.arg.originalArgs)) return
      held = []
    }
  })
}
