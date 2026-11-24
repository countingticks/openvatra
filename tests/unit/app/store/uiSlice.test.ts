import { describe, expect, it } from 'vitest'
import {
  historyLimit,
  initialUiState,
  navigated,
  routeReplaced,
  selectActiveTab,
  selectCanGoBack,
  selectCanGoForward,
  selectRoute,
  selectSidebarOpen,
  settingsClosed,
  settingsOpened,
  settingsSectionSelected,
  modelsTabSelected,
  sidebarToggled,
  tabSelected,
  uiSlice,
  wentBack,
  wentForward,
  type UiState
} from '@app/store/uiSlice'
import type { Route } from '@app/store/route'
import type { TabId } from '@shared/settings'

// A reducer is a pure function (state, action) → next state, so it's tested by calling it directly.
const reduce = uiSlice.reducer

/** The state after visiting these tabs in order, starting from Chat. */
const visit = (...ids: TabId[]): UiState =>
  ids.reduce((state, id) => reduce(state, tabSelected(id)), initialUiState)

/** The state after navigating to these routes in order, starting from Chat. */
const go = (...routes: Route[]): UiState =>
  routes.reduce((state, route) => reduce(state, navigated(route)), initialUiState)

const chat = (chatId: string): Route => ({ tab: 'chat', chatId })

describe('ui slice', () => {
  it('starts on Chat with the sidebar open and no history', () => {
    expect(reduce(undefined, { type: 'unknown' })).toEqual({
      route: { tab: 'chat' },
      sidebarOpen: true,
      back: [],
      forward: [],
      tabRoutes: { chat: { tab: 'chat' }, code: { tab: 'code' }, automations: { tab: 'automations' } },
      settingsOpen: false,
      settingsSection: 'general',
      modelsTab: 'installed',
      expandModel: null
    })
  })

  it('opens and closes the Settings dialog without changing the open tab', () => {
    const open = reduce(visit('code'), settingsOpened())
    expect(open).toMatchObject({ settingsOpen: true, route: { tab: 'code' } })
    expect(reduce(open, settingsClosed()).settingsOpen).toBe(false)
  })

  it('opens Settings on General unless a section is named, and switches sections', () => {
    const onModels = reduce(initialUiState, settingsOpened({ section: 'models' }))
    expect(onModels.settingsSection).toBe('models')
    expect(reduce(onModels, settingsSectionSelected('general')).settingsSection).toBe('general')
    expect(reduce(onModels, settingsOpened()).settingsSection).toBe('general')
  })

  it('settingsOpened() resets the tab and the expanded model; a target sets all three', () => {
    const target = reduce(initialUiState, settingsOpened({ section: 'models', tab: 'more', expand: 'x' }))
    expect(target).toMatchObject({ settingsSection: 'models', modelsTab: 'more', expandModel: 'x' })

    expect(reduce(target, settingsOpened())).toMatchObject({
      settingsSection: 'general',
      modelsTab: 'installed',
      expandModel: null
    })
    expect(reduce(target, modelsTabSelected('installed')).modelsTab).toBe('installed')
  })

  it('switches to the selected tab', () => {
    expect(reduce(initialUiState, tabSelected('automations')).route).toEqual({ tab: 'automations' })
  })

  it('closes the sidebar, then opens it again', () => {
    const closed = reduce(initialUiState, sidebarToggled())
    expect(closed.sidebarOpen).toBe(false)
    expect(reduce(closed, sidebarToggled()).sidebarOpen).toBe(true)
  })

  it('never changes the state it was given', () => {
    const before = structuredClone(initialUiState)
    reduce(initialUiState, tabSelected('code'))
    expect(initialUiState).toEqual(before)
  })

  it('reads its values from the whole app state', () => {
    const route: Route = { tab: 'automations', triggerId: 't' }
    const state = { ui: { ...initialUiState, route, sidebarOpen: false } }
    expect(selectActiveTab(state)).toBe('automations')
    expect(selectRoute(state)).toBe(route)
    expect(selectSidebarOpen(state)).toBe(false)
  })
})

describe('back and forward', () => {
  it('remembers where you came from', () => {
    const state = visit('code', 'automations')

    expect(state.back).toEqual([{ tab: 'chat' }, { tab: 'code' }])
    expect(selectCanGoBack({ ui: state })).toBe(true)
    expect(selectCanGoForward({ ui: state })).toBe(false)
  })

  it('goes back one step at a time, and forward again', () => {
    let state = visit('code', 'automations')

    state = reduce(state, wentBack())
    expect(state.route).toEqual({ tab: 'code' })
    state = reduce(state, wentBack())
    expect(state.route).toEqual({ tab: 'chat' })

    state = reduce(state, wentForward())
    expect(state.route).toEqual({ tab: 'code' })
    state = reduce(state, wentForward())
    expect(state.route).toEqual({ tab: 'automations' })
  })

  it('forgets the forward path when you choose a new tab after going back, as a browser does', () => {
    let state = visit('code', 'automations')
    state = reduce(state, wentBack())

    state = reduce(state, tabSelected('automations'))

    expect(state.forward).toEqual([])
    expect(state.back).toEqual([{ tab: 'chat' }, { tab: 'code' }])
  })

  it('does nothing when there is nowhere to go', () => {
    expect(reduce(initialUiState, wentBack())).toEqual(initialUiState)
    expect(reduce(initialUiState, wentForward())).toEqual(initialUiState)
  })

  it('does not record selecting the tab that is already open', () => {
    expect(visit('chat').back).toEqual([])
  })

  it(`keeps at most ${historyLimit} steps`, () => {
    const many = Array.from({ length: historyLimit + 10 }, (_, i): TabId => (i % 2 ? 'chat' : 'code'))

    expect(visit(...many).back).toHaveLength(historyLimit)
  })

  it('records a move to a chat id, and clears forward', () => {
    let state = go(chat('a'), chat('b'))
    state = reduce(state, wentBack())
    expect(state.forward).toEqual([chat('b')])

    state = reduce(state, navigated(chat('c')))

    expect(state.route).toEqual(chat('c'))
    expect(state.back).toEqual([{ tab: 'chat' }, chat('a')])
    expect(state.forward).toEqual([])
  })

  it('changes nothing when navigating to the current route', () => {
    const state = go(chat('a'))

    expect(reduce(state, navigated(chat('a')))).toBe(state)
  })

  it("returns to a tab's last route when it is selected again", () => {
    const state = reduce(reduce(go(chat('a')), tabSelected('code')), tabSelected('chat'))

    expect(state.route).toEqual(chat('a'))
  })

  it('does nothing when the open tab is selected while it shows an id', () => {
    const state = go(chat('a'))

    expect(reduce(state, tabSelected('chat'))).toBe(state)
  })

  it("updates the tab's remembered route on Back and Forward", () => {
    let state = reduce(go(chat('a'), chat('b')), wentBack())
    state = reduce(reduce(state, tabSelected('code')), tabSelected('chat'))
    expect(state.route).toEqual(chat('a'))

    state = reduce(reduce(go(chat('a'), chat('b')), wentBack()), wentForward())
    state = reduce(reduce(state, tabSelected('code')), tabSelected('chat'))
    expect(state.route).toEqual(chat('b'))
  })

  it(`keeps at most ${historyLimit} steps when navigating`, () => {
    const many = Array.from({ length: historyLimit + 10 }, (_, i) => chat(String(i)))

    expect(go(...many).back).toHaveLength(historyLimit)
  })

  it('replaces a new chat with its id without a Back entry', () => {
    const state = reduce(initialUiState, routeReplaced(chat('c1')))

    expect(selectRoute({ ui: state })).toEqual(chat('c1'))
    expect(selectCanGoBack({ ui: state })).toBe(false)
    expect(state.tabRoutes.chat).toEqual(chat('c1'))
  })
})
