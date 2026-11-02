import { describe, expect, it } from 'vitest'
import {
  initialUiState,
  selectActiveTab,
  selectSidebarOpen,
  sidebarToggled,
  tabSelected,
  uiSlice
} from '@renderer/store/uiSlice'

// A reducer is a pure function (state, action) → next state, so it's tested by calling it directly.
const reduce = uiSlice.reducer

describe('ui slice', () => {
  it('starts on Chat with the sidebar open', () => {
    expect(reduce(undefined, { type: 'unknown' })).toEqual({ activeTab: 'chat', sidebarOpen: true })
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
    const state = { ui: { activeTab: 'settings' as const, sidebarOpen: false } }
    expect(selectActiveTab(state)).toBe('settings')
    expect(selectSidebarOpen(state)).toBe(false)
  })
})
