// UI state that several parts of the window share: where the window is (a route), whether the sidebar is shown, and where
// you've been (for Back / Forward).
// A slice is one feature's state plus the reducers that change it; Redux Toolkit writes the action types and
// action creators from the reducer names.
import { createSlice, type PayloadAction } from '@reduxjs/toolkit'
import type { TabId } from '@shared/settings'
import { sameRoute, type Route } from './route'

/** The Settings dialog's sections, in nav order. */
export const settingsSections = ['general', 'models'] as const
export type SettingsSection = (typeof settingsSections)[number]

export interface UiState {
  /** Where the window is: a tab and what is open in it. */
  route: Route
  sidebarOpen: boolean
  /** Where Back goes, most recent last (a stack). Lives here, not in its own slice, because every move changes
   * the history and the route together. Not saved across restarts. */
  back: Route[]
  /** Where Forward goes after going back, most recent last; emptied by navigating somewhere new. */
  forward: Route[]
  /** Each tab's last route, so choosing a tab returns to what was open in it. Session only. */
  tabRoutes: Record<TabId, Route>
  /** The Settings dialog is open. Not saved: the app never reopens with a dialog in the way. */
  settingsOpen: boolean
  /** Which section the dialog shows. */
  settingsSection: SettingsSection
  /** The Models dialog (get or remove models) is open. Not saved, like the Settings dialog. */
  modelsDialogOpen: boolean
}

/** Enough to go back a long way, small enough that the history never grows without bound. */
export const historyLimit = 50

export const initialUiState: UiState = {
  route: { tab: 'chat' },
  sidebarOpen: true,
  back: [],
  forward: [],
  tabRoutes: { chat: { tab: 'chat' }, code: { tab: 'code' }, automations: { tab: 'automations' } },
  settingsOpen: false,
  settingsSection: 'general',
  modelsDialogOpen: false
}

/** Moves to a route: the old one goes on the Back stack, and the tab remembers where it was left. */
function navigate(state: UiState, route: Route): void {
  if (sameRoute(route, state.route)) return
  state.back.push(state.route)
  if (state.back.length > historyLimit) state.back.shift()
  // A new move makes the old "forward" path meaningless, as in a browser.
  state.forward = []
  state.route = route
  state.tabRoutes[route.tab] = route
}

export const uiSlice = createSlice({
  name: 'ui',
  initialState: initialUiState,
  // Reducers look like they mutate `state`, but Redux Toolkit (via Immer) turns that into a new, immutable state.
  reducers: {
    navigated(state, action: PayloadAction<Route>) {
      navigate(state, action.payload)
    },
    tabSelected(state, action: PayloadAction<TabId>) {
      navigate(state, state.tabRoutes[action.payload])
    },
    wentBack(state) {
      const previous = state.back.pop()
      if (previous === undefined) return
      state.forward.push(state.route)
      state.route = previous
      state.tabRoutes[previous.tab] = previous
    },
    wentForward(state) {
      const next = state.forward.pop()
      if (next === undefined) return
      state.back.push(state.route)
      state.route = next
      state.tabRoutes[next.tab] = next
    },
    sidebarToggled(state) {
      state.sidebarOpen = !state.sidebarOpen
    },
    /** Opens on General unless a section is named ("Model settings…" opens on Models). */
    settingsOpened(state, action: PayloadAction<SettingsSection | undefined>) {
      state.settingsOpen = true
      state.settingsSection = action.payload ?? 'general'
    },
    settingsSectionSelected(state, action: PayloadAction<SettingsSection>) {
      state.settingsSection = action.payload
    },
    settingsClosed(state) {
      state.settingsOpen = false
    },
    modelsDialogOpened(state) {
      state.modelsDialogOpen = true
    },
    modelsDialogClosed(state) {
      state.modelsDialogOpen = false
    }
  },
  selectors: {
    selectRoute: (state) => state.route,
    selectActiveTab: (state) => state.route.tab,
    selectSidebarOpen: (state) => state.sidebarOpen,
    selectCanGoBack: (state) => state.back.length > 0,
    selectCanGoForward: (state) => state.forward.length > 0,
    selectSettingsOpen: (state) => state.settingsOpen,
    selectSettingsSection: (state) => state.settingsSection,
    selectModelsDialogOpen: (state) => state.modelsDialogOpen
  }
})

export const {
  navigated,
  tabSelected,
  wentBack,
  wentForward,
  sidebarToggled,
  settingsOpened,
  settingsSectionSelected,
  settingsClosed,
  modelsDialogOpened,
  modelsDialogClosed
} = uiSlice.actions
export const {
  selectRoute,
  selectActiveTab,
  selectSidebarOpen,
  selectCanGoBack,
  selectCanGoForward,
  selectSettingsOpen,
  selectSettingsSection,
  selectModelsDialogOpen
} = uiSlice.selectors
