// How this window reaches core right now: the address and ui token main handed over, or null while core is not
// ready. The base query and the event stream read it at the moment they need it.
import { createSlice, type PayloadAction } from '@reduxjs/toolkit'
import type { CoreConnection } from '../../../shared/core'

const sameConnection = (a: CoreConnection | null, b: CoreConnection | null): boolean =>
  a === b || (a !== null && b !== null && a.baseUrl === b.baseUrl && a.token === b.token)

export const connectionSlice = createSlice({
  name: 'coreConnection',
  initialState: null as CoreConnection | null,
  reducers: {
    // An equal connection keeps the current object, so the stream (which compares by reference) does not restart.
    connectionChanged: (state, action: PayloadAction<CoreConnection | null>) =>
      sameConnection(state, action.payload) ? state : action.payload
  }
})

export const { connectionChanged } = connectionSlice.actions

export function selectConnection(state: { coreConnection: CoreConnection | null }): CoreConnection | null {
  return state.coreConnection
}
