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

/** The tabs of Settings › Models. */
export const modelsTabs = ['installed', 'more'] as const
export type ModelsTab = (typeof modelsTabs)[number]

/** Where Settings opens: a section, and for Models its tab and the model whose options start open. */
export interface SettingsTarget {
  section?: SettingsSection
  tab?: ModelsTab
  expand?: string
}

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
  /** Which tab Settings › Models shows. */
  modelsTab: ModelsTab
  /** The model id whose options the Installed list opens when it mounts; null for none. */
  expandModel: string | null
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
  modelsTab: 'installed',
  expandModel: null
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
    /** Changes what is open without a history entry: a new chat that got its id is still the same place. */
    routeReplaced(state, action: PayloadAction<Route>) {
      if (sameRoute(action.payload, state.route)) return
      state.route = action.payload
      state.tabRoutes[action.payload.tab] = action.payload
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
    /** Opens on General, the Installed tab and no open model unless a target says otherwise. */
    settingsOpened(state, action: PayloadAction<SettingsTarget | undefined>) {
      state.settingsOpen = true
      state.settingsSection = action.payload?.section ?? 'general'
      state.modelsTab = action.payload?.tab ?? 'installed'
      state.expandModel = action.payload?.expand ?? null
    },
    modelsTabSelected(state, action: PayloadAction<ModelsTab>) {
      state.modelsTab = action.payload
    },
    settingsSectionSelected(state, action: PayloadAction<SettingsSection>) {
      state.settingsSection = action.payload
    },
    settingsClosed(state) {
      state.settingsOpen = false
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
    selectModelsTab: (state) => state.modelsTab,
    selectExpandModel: (state) => state.expandModel
  }
})

export const {
  navigated,
  routeReplaced,
  tabSelected,
  wentBack,
  wentForward,
  sidebarToggled,
  settingsOpened,
  settingsSectionSelected,
  settingsClosed,
  modelsTabSelected
} = uiSlice.actions
export const {
  selectRoute,
  selectActiveTab,
  selectSidebarOpen,
  selectCanGoBack,
  selectCanGoForward,
  selectSettingsOpen,
  selectSettingsSection,
  selectModelsTab,
  selectExpandModel
} = uiSlice.selectors
