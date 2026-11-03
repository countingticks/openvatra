// UI state that several parts of the window share: which tab is open, whether the sidebar is shown, and where
// you've been (for Back / Forward).
// A slice is one feature's state plus the reducers that change it; Redux Toolkit writes the action types and
// action creators from the reducer names.
import { createSlice, type PayloadAction } from '@reduxjs/toolkit'
import type { TabId } from '../../../shared/settings'

export interface UiState {
  activeTab: TabId
  sidebarOpen: boolean
  /** Where Back goes, most recent last (a stack). Lives here, not in its own slice, because every move changes
   * the history and the active tab together. Not saved across restarts. */
  back: TabId[]
  /** Where Forward goes after going back, most recent last; emptied by choosing a new tab. */
  forward: TabId[]
}

/** Enough to go back a long way, small enough that the history never grows without bound. */
export const historyLimit = 50

export const initialUiState: UiState = {
  activeTab: 'chat',
  sidebarOpen: true,
  back: [],
  forward: []
}

export const uiSlice = createSlice({
  name: 'ui',
  initialState: initialUiState,
  // Reducers look like they mutate `state`, but Redux Toolkit (via Immer) turns that into a new, immutable state.
  reducers: {
    tabSelected(state, action: PayloadAction<TabId>) {
      if (action.payload === state.activeTab) return
      state.back.push(state.activeTab)
      if (state.back.length > historyLimit) state.back.shift()
      // A new move makes the old "forward" path meaningless, as in a browser.
      state.forward = []
      state.activeTab = action.payload
    },
    wentBack(state) {
      const previous = state.back.pop()
      if (previous === undefined) return
      state.forward.push(state.activeTab)
      state.activeTab = previous
    },
    wentForward(state) {
      const next = state.forward.pop()
      if (next === undefined) return
      state.back.push(state.activeTab)
      state.activeTab = next
    },
    sidebarToggled(state) {
      state.sidebarOpen = !state.sidebarOpen
    }
  },
  selectors: {
    selectActiveTab: (state) => state.activeTab,
    selectSidebarOpen: (state) => state.sidebarOpen,
    selectCanGoBack: (state) => state.back.length > 0,
    selectCanGoForward: (state) => state.forward.length > 0
  }
})

export const { tabSelected, wentBack, wentForward, sidebarToggled } = uiSlice.actions
export const { selectActiveTab, selectSidebarOpen, selectCanGoBack, selectCanGoForward } = uiSlice.selectors
