// Live text of every answering run, from core's ephemeral deltas; never patched into the durable transcript.
import { createSlice, type WithSlice } from '@reduxjs/toolkit'
import { coreEvent } from '@app/core/events'
import type { SchedState } from '@app/core/generated'
import type { RootState } from '@app/store/store'
import { runIdOf, type LiveAnswer } from './runView'

export interface LiveState {
  runs: Record<string, LiveAnswer>
  sched: SchedState | null
}

const initialState: LiveState = { runs: {}, sched: null }

export const liveSlice = createSlice({
  name: 'live',
  initialState,
  reducers: {},
  extraReducers: (builder) => {
    builder.addCase(coreEvent, (state, action) => {
      const event = action.payload
      const runId = runIdOf(event)
      switch (event.type) {
        case 'message.delta':
        case 'reasoning.delta': {
          if (runId === null) return
          const entry = state.runs[runId] ?? { text: '', reasoning: '', n: 0, reasoningAt: null }
          // A delta the entry already holds (from a partial, or sent twice) would double its text (decision 11).
          if (event.data.n <= entry.n) return
          if (event.type === 'message.delta') entry.text += event.data.text
          else {
            entry.reasoning += event.data.text
            entry.reasoningAt ??= Date.now()
          }
          entry.n = event.data.n
          state.runs[runId] = entry
          return
        }
        case 'message.partial': {
          if (runId === null) return
          const entry = state.runs[runId]
          if (entry !== undefined && event.data.n < entry.n) return
          const { text, reasoning, n } = event.data
          const reasoningAt = entry?.reasoningAt ?? (reasoning !== '' ? Date.now() : null)
          state.runs[runId] = { text, reasoning, n, reasoningAt }
          return
        }
        case 'message.completed':
        case 'run.finished':
          // chat.deleted needs nothing: core finishes the chat's runs before it deletes the chat.
          if (runId !== null) delete state.runs[runId]
          return
        case 'sched.state':
          state.sched = event.data
          return
      }
    })
  }
})

declare module '@app/store/store' {
  interface LazySlices extends WithSlice<typeof liveSlice> {}
}

export const selectLiveAnswer = (state: RootState, runId: string): LiveAnswer | undefined =>
  state.live?.runs[runId]

export const selectSched = (state: RootState): SchedState | null => state.live?.sched ?? null
