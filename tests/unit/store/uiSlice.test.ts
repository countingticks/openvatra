import { describe, expect, it } from 'vitest'
import {
  historyLimit,
  initialUiState,
  selectActiveTab,
  selectCanGoBack,
  selectCanGoForward,
  selectSidebarOpen,
  settingsClosed,
  settingsOpened,
  sidebarToggled,
  tabSelected,
  uiSlice,
  wentBack,
  wentForward,
  type UiState
} from '@renderer/store/uiSlice'
import type { TabId } from '../../../src/shared/settings'

// A reducer is a pure function (state, action) → next state, so it's tested by calling it directly.
const reduce = uiSlice.reducer

/** The state after visiting these tabs in order, starting from Chat. */
const visit = (...ids: TabId[]): UiState =>
  ids.reduce((state, id) => reduce(state, tabSelected(id)), initialUiState)

describe('ui slice', () => {
  it('starts on Chat with the sidebar open and no history', () => {
    expect(reduce(undefined, { type: 'unknown' })).toEqual({
      activeTab: 'chat',
      sidebarOpen: true,
      back: [],
      forward: [],
      settingsOpen: false
    })
  })

  it('opens and closes the Settings dialog without changing the open tab', () => {
    const open = reduce(visit('code'), settingsOpened())
    expect(open).toMatchObject({ settingsOpen: true, activeTab: 'code' })
    expect(reduce(open, settingsClosed()).settingsOpen).toBe(false)
  })

  it('switches to the selected tab', () => {
    expect(reduce(initialUiState, tabSelected('automations')).activeTab).toBe('automations')
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
    const state = { ui: { ...initialUiState, activeTab: 'automations' as const, sidebarOpen: false } }
    expect(selectActiveTab(state)).toBe('automations')
    expect(selectSidebarOpen(state)).toBe(false)
  })
})

describe('back and forward', () => {
  it('remembers where you came from', () => {
    const state = visit('code', 'automations')

    expect(state.back).toEqual(['chat', 'code'])
    expect(selectCanGoBack({ ui: state })).toBe(true)
    expect(selectCanGoForward({ ui: state })).toBe(false)
  })

  it('goes back one step at a time, and forward again', () => {
    let state = visit('code', 'automations')

    state = reduce(state, wentBack())
    expect(state.activeTab).toBe('code')
    state = reduce(state, wentBack())
    expect(state.activeTab).toBe('chat')

    state = reduce(state, wentForward())
    expect(state.activeTab).toBe('code')
    state = reduce(state, wentForward())
    expect(state.activeTab).toBe('automations')
  })

  it('forgets the forward path when you choose a new tab after going back, as a browser does', () => {
    let state = visit('code', 'automations')
    state = reduce(state, wentBack())

    state = reduce(state, tabSelected('automations'))

    expect(state.forward).toEqual([])
    expect(state.back).toEqual(['chat', 'code'])
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
})
