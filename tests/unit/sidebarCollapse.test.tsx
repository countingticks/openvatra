import { fireEvent, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { App } from '@renderer/App'
import { renderWithStore } from './renderWithStore'

const panel = (): HTMLElement => document.getElementById('sidebar') as HTMLElement
const closeButton = (): HTMLElement => screen.getByRole('button', { name: 'Close sidebar' })
const openButton = (): HTMLElement => screen.getByRole('button', { name: 'Open sidebar' })
const pressCtrlB = (): void => {
  fireEvent.keyDown(window, { key: 'b', ctrlKey: true })
}

// jsdom has no layout or CSS, so the slide itself can't be seen here; these tests check the states the CSS keys
// off (data-state) and what keyboard and screen-reader users get (inert, aria-expanded, focus).
describe('collapsible sidebar', () => {
  it('starts open, with the opener out of the way', () => {
    renderWithStore(<App />)

    expect(panel()).toHaveAttribute('data-state', 'open')
    expect(panel()).not.toHaveAttribute('inert')
    expect(closeButton()).toHaveAttribute('aria-expanded', 'true')
    expect(openButton()).toHaveAttribute('inert')
  })

  it('closes with its button: hidden from the keyboard and screen readers, not just from view', () => {
    renderWithStore(<App />)

    fireEvent.click(closeButton())

    expect(panel()).toHaveAttribute('data-state', 'closed')
    expect(panel()).toHaveAttribute('inert')
    expect(openButton()).not.toHaveAttribute('inert')
    expect(openButton()).toHaveAttribute('aria-expanded', 'false')
  })

  it('opens again with the button by the content', () => {
    renderWithStore(<App />)
    fireEvent.click(closeButton())

    fireEvent.click(openButton())

    expect(panel()).toHaveAttribute('data-state', 'open')
    expect(panel()).not.toHaveAttribute('inert')
  })

  it('toggles with Ctrl+B, and ignores Ctrl+Shift+B', () => {
    renderWithStore(<App />)

    pressCtrlB()
    expect(panel()).toHaveAttribute('data-state', 'closed')

    fireEvent.keyDown(window, { key: 'B', ctrlKey: true, shiftKey: true })
    expect(panel()).toHaveAttribute('data-state', 'closed')

    pressCtrlB()
    expect(panel()).toHaveAttribute('data-state', 'open')
  })

  it('keeps the tabs: closing the sidebar does not change the open tab', () => {
    const { store } = renderWithStore(<App />, { lastTab: 'code' })

    pressCtrlB()

    expect(store.getState().ui.activeTab).toBe('code')
    expect(screen.getByRole('heading', { level: 1, name: 'Code' })).toBeInTheDocument()
  })

  describe('focus', () => {
    it('moves to the opener when the close button hides itself, and back when reopened', () => {
      renderWithStore(<App />)

      closeButton().focus()
      fireEvent.click(closeButton())
      expect(openButton()).toHaveFocus()

      fireEvent.click(openButton())
      expect(closeButton()).toHaveFocus()
    })

    it('moves to the opener when Ctrl+B hides the tab that had it', () => {
      renderWithStore(<App />)
      const nav = screen.getByRole('navigation', { name: 'Main' })
      within(nav).getByRole('button', { name: 'Code' }).focus()

      pressCtrlB()

      expect(openButton()).toHaveFocus()
    })

    it('stays put when it was somewhere else', () => {
      renderWithStore(<App />)
      const outside = document.createElement('button')
      document.body.append(outside)
      outside.focus()

      pressCtrlB()

      expect(outside).toHaveFocus()
      outside.remove()
    })
  })
})
