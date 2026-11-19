import { fireEvent, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { Shell } from '@app/shell/Shell'
import { renderWithStore } from '../../renderWithStore'

const panel = (): HTMLElement => document.getElementById('sidebar') as HTMLElement
// One toggle in the title bar, always visible; aria-expanded says whether the sidebar is open.
const toggle = (): HTMLElement => screen.getByRole('button', { name: 'Sidebar' })
const pressCtrlB = (): void => {
  fireEvent.keyDown(window, { key: 'b', ctrlKey: true })
}

// jsdom has no layout or CSS, so the slide itself can't be seen here; these tests check the states the CSS keys
// off (data-state) and what keyboard and screen-reader users get (inert, aria-expanded, focus).
describe('collapsible sidebar', () => {
  it('starts open', () => {
    renderWithStore(<Shell />)

    expect(panel()).toHaveAttribute('data-state', 'open')
    expect(panel()).not.toHaveAttribute('inert')
    expect(toggle()).toHaveAttribute('aria-expanded', 'true')
  })

  it('opens the way it was left', () => {
    renderWithStore(<Shell />, { sidebarOpen: false })

    expect(panel()).toHaveAttribute('data-state', 'closed')
    expect(toggle()).toHaveAttribute('aria-expanded', 'false')
  })

  it('closes with the toggle: hidden from the keyboard and screen readers, not just from view', () => {
    renderWithStore(<Shell />)

    fireEvent.click(toggle())

    expect(panel()).toHaveAttribute('data-state', 'closed')
    expect(panel()).toHaveAttribute('inert')
    expect(toggle()).toHaveAttribute('aria-expanded', 'false')
  })

  it('opens again with the same toggle, which stays where it is', () => {
    renderWithStore(<Shell />)
    fireEvent.click(toggle())

    fireEvent.click(toggle())

    expect(panel()).toHaveAttribute('data-state', 'open')
    expect(panel()).not.toHaveAttribute('inert')
  })

  it('toggles with Ctrl+B, and ignores Ctrl+Shift+B', () => {
    renderWithStore(<Shell />)

    pressCtrlB()
    expect(panel()).toHaveAttribute('data-state', 'closed')

    fireEvent.keyDown(window, { key: 'B', ctrlKey: true, shiftKey: true })
    expect(panel()).toHaveAttribute('data-state', 'closed')

    pressCtrlB()
    expect(panel()).toHaveAttribute('data-state', 'open')
  })

  it('keeps the tabs: closing the sidebar does not change the open tab', () => {
    const { store } = renderWithStore(<Shell />, { lastTab: 'code' })

    pressCtrlB()

    expect(store.getState().ui.activeTab).toBe('code')
    expect(screen.getByRole('heading', { level: 1, name: 'Code' })).toBeInTheDocument()
  })

  describe('focus', () => {
    it('stays on the toggle when the toggle is used', () => {
      renderWithStore(<Shell />)

      toggle().focus()
      fireEvent.click(toggle())

      expect(toggle()).toHaveFocus()
    })

    it('moves to the toggle when Ctrl+B hides the tab that had it', () => {
      renderWithStore(<Shell />)
      const nav = screen.getByRole('navigation', { name: 'Main' })
      within(nav).getByRole('button', { name: 'Code' }).focus()

      pressCtrlB()

      expect(toggle()).toHaveFocus()
    })

    it('stays put when it was somewhere else', () => {
      renderWithStore(<Shell />)
      const outside = document.createElement('button')
      document.body.append(outside)
      outside.focus()

      pressCtrlB()

      expect(outside).toHaveFocus()
      outside.remove()
    })
  })
})
