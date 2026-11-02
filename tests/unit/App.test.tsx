import { fireEvent, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { App } from '@renderer/App'
import { renderWithStore } from './renderWithStore'

const sidebar = (): HTMLElement => screen.getByRole('navigation', { name: 'Main' })
const tabButton = (name: string): HTMLElement => within(sidebar()).getByRole('button', { name })

describe('App', () => {
  it('shows a sidebar with the four tabs in order', () => {
    renderWithStore(<App />)

    const names = within(sidebar())
      .getAllByRole('button')
      .map((button) => button.textContent)
    expect(names).toEqual(['Chat', 'Code', 'Automations', 'Settings'])
  })

  it('opens on Chat the first time', () => {
    renderWithStore(<App />)

    expect(tabButton('Chat')).toHaveAttribute('aria-current', 'page')
    expect(screen.getByRole('heading', { level: 1, name: 'Chat' })).toBeInTheDocument()
    expect(screen.getByRole('img', { name: 'Ember, idle' })).toBeInTheDocument()
  })

  it('opens on the tab saved last time', () => {
    renderWithStore(<App />, 'automations')

    expect(tabButton('Automations')).toHaveAttribute('aria-current', 'page')
    expect(screen.getByRole('heading', { level: 1, name: 'Automations' })).toBeInTheDocument()
  })

  it('switches tabs when a sidebar item is clicked', () => {
    renderWithStore(<App />)

    fireEvent.click(tabButton('Code'))

    expect(tabButton('Code')).toHaveAttribute('aria-current', 'page')
    expect(tabButton('Chat')).not.toHaveAttribute('aria-current')
    expect(screen.getByRole('heading', { level: 1, name: 'Code' })).toBeInTheDocument()
    expect(screen.getByText(/coming in a later version/i)).toBeInTheDocument()
  })

  it.each([
    ['1', 'Chat'],
    ['2', 'Code'],
    ['3', 'Automations'],
    ['4', 'Settings']
  ])('Ctrl+%s opens %s', (key, name) => {
    // Start somewhere else, so Ctrl+1 really has to switch.
    renderWithStore(<App />, key === '1' ? 'settings' : 'chat')

    fireEvent.keyDown(window, { key, ctrlKey: true })

    expect(tabButton(name)).toHaveAttribute('aria-current', 'page')
  })

  it('ignores the digit without Ctrl, and Ctrl with other modifiers or digits', () => {
    renderWithStore(<App />)

    fireEvent.keyDown(window, { key: '2' })
    fireEvent.keyDown(window, { key: '2', ctrlKey: true, shiftKey: true })
    fireEvent.keyDown(window, { key: '2', ctrlKey: true, altKey: true })
    fireEvent.keyDown(window, { key: '5', ctrlKey: true })

    expect(tabButton('Chat')).toHaveAttribute('aria-current', 'page')
  })

  it('announces each shortcut to assistive technology', () => {
    renderWithStore(<App />)

    expect(tabButton('Chat')).toHaveAttribute('aria-keyshortcuts', 'Control+1')
    expect(tabButton('Settings')).toHaveAttribute('aria-keyshortcuts', 'Control+4')
  })

  it('remembers the newly opened tab in settings', async () => {
    const { saveSettings } = renderWithStore(<App />)

    fireEvent.click(tabButton('Settings'))

    await vi.waitFor(() => expect(saveSettings).toHaveBeenCalledWith({ lastTab: 'settings' }))
  })

  it('stops listening for shortcuts once it is gone', () => {
    const { store, unmount } = renderWithStore(<App />)

    unmount()
    fireEvent.keyDown(window, { key: '3', ctrlKey: true })

    expect(store.getState().ui.activeTab).toBe('chat')
  })
})
