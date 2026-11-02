// UI state that several parts of the window share: which tab is open and whether the sidebar is shown.
// A slice is one feature's state plus the reducers that change it; Redux Toolkit writes the action types and
// action creators from the reducer names.
import { createSlice, type PayloadAction } from '@reduxjs/toolkit'
import type { TabId } from '../../../shared/settings'

export interface UiState {
  activeTab: TabId
  sidebarOpen: boolean
}

export const initialUiState: UiState = {
  activeTab: 'chat',
  sidebarOpen: true
}

export const uiSlice = createSlice({
  name: 'ui',
  initialState: initialUiState,
  // Reducers look like they mutate `state`, but Redux Toolkit (via Immer) turns that into a new, immutable state.
  reducers: {
    tabSelected(state, action: PayloadAction<TabId>) {
      state.activeTab = action.payload
    },
    sidebarToggled(state) {
      state.sidebarOpen = !state.sidebarOpen
    }
  },
  selectors: {
    selectActiveTab: (state) => state.activeTab,
    selectSidebarOpen: (state) => state.sidebarOpen
  }
})

export const { tabSelected, sidebarToggled } = uiSlice.actions
export const { selectActiveTab, selectSidebarOpen } = uiSlice.selectors
