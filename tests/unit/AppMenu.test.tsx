import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { App } from '@renderer/App'
import { renderWithStore } from './renderWithStore'

const menuButton = (): HTMLElement => screen.getByRole('button', { name: 'Menu' })

async function openMenu(): Promise<HTMLElement> {
  fireEvent.click(menuButton())
  return screen.findByRole('menu', { name: 'Menu' })
}

/** Opens ≡ → `menu` and returns that submenu. */
async function openSubmenu(menu: string): Promise<HTMLElement> {
  const root = await openMenu()
  fireEvent.click(within(root).getByRole('menuitem', { name: menu }))
  return screen.findByRole('menu', { name: menu })
}

const item = (menu: HTMLElement, name: string | RegExp): HTMLElement =>
  within(menu).getByRole('menuitem', { name })

describe('app menu', () => {
  it('sits first in the title bar, before the sidebar toggle', () => {
    renderWithStore(<App />)

    const names = within(screen.getByRole('banner'))
      .getAllByRole('button')
      .map((button) => button.getAttribute('aria-label'))
    expect(names.slice(0, 2)).toEqual(['Menu', 'Sidebar'])
  })

  it('opens a list of File, Edit, View, Go and Help', async () => {
    renderWithStore(<App />)

    const root = await openMenu()

    const names = within(root)
      .getAllByRole('menuitem')
      .map((row) => row.textContent)
    expect(names).toEqual(['File', 'Edit', 'View', 'Go', 'Help'])
  })

  it('closes with Esc', async () => {
    renderWithStore(<App />)
    const root = await openMenu()

    fireEvent.keyDown(root, { key: 'Escape' })

    await waitFor(() => expect(screen.queryByRole('menu', { name: 'Menu' })).not.toBeInTheDocument())
  })

  describe('File', () => {
    it('quits OpenVatra', async () => {
      const { quit } = renderWithStore(<App />)

      fireEvent.click(item(await openSubmenu('File'), /Quit OpenVatra/))

      expect(quit).toHaveBeenCalledOnce()
    })

    it('closes the window', async () => {
      const { appWindow } = renderWithStore(<App />)

      fireEvent.click(item(await openSubmenu('File'), /Close window/))

      expect(appWindow.close).toHaveBeenCalledOnce()
    })

    it('opens Settings', async () => {
      renderWithStore(<App />)

      fireEvent.click(item(await openSubmenu('File'), /Settings/))

      expect(await screen.findByRole('dialog', { name: 'Settings' })).toBeInTheDocument()
    })

    it('shows New chat as not available yet', async () => {
      renderWithStore(<App />)

      expect(item(await openSubmenu('File'), /New chat/)).toHaveAttribute('aria-disabled', 'true')
    })
  })

  describe('Edit', () => {
    it('runs the command on the field that had focus before the menu opened', async () => {
      const { appWindow } = renderWithStore(<App />)
      const field = document.createElement('input')
      document.body.append(field)
      field.focus()
      // What matters is where focus is when the command reaches Chromium, not when the item is clicked.
      let focusedWhenSent: Element | null = null
      appWindow.edit.mockImplementation(async () => {
        focusedWhenSent = document.activeElement
      })

      fireEvent.click(item(await openSubmenu('Edit'), /Copy/))

      await waitFor(() => expect(appWindow.edit).toHaveBeenCalledWith('copy'))
      expect(focusedWhenSent).toBe(field)
      field.remove()
    })

    it('offers undo, redo, cut, copy, paste and select all', async () => {
      renderWithStore(<App />)

      const names = within(await openSubmenu('Edit'))
        .getAllByRole('menuitem')
        .map((row) => row.textContent?.replace(/Ctrl\+.*/, '').trim())
      expect(names).toEqual(['Undo', 'Redo', 'Cut', 'Copy', 'Paste', 'Select all'])
    })
  })

  describe('View', () => {
    it('switches tabs, with the open one marked', async () => {
      renderWithStore(<App />)
      const view = await openSubmenu('View')

      expect(within(view).getByRole('menuitemradio', { name: /Chat/ })).toHaveAttribute(
        'aria-checked',
        'true'
      )
      fireEvent.click(within(view).getByRole('menuitemradio', { name: /Code/ }))

      expect(await screen.findByRole('heading', { level: 1, name: 'Code' })).toBeInTheDocument()
    })

    it('toggles the sidebar', async () => {
      renderWithStore(<App />)

      fireEvent.click(item(await openSubmenu('View'), /Toggle sidebar/))

      expect(screen.getByRole('button', { name: 'Sidebar' })).toHaveAttribute('aria-expanded', 'false')
    })
  })

  it('Go: Back and Forward are dimmed while there is no history', async () => {
    renderWithStore(<App />)
    const go = await openSubmenu('Go')

    expect(item(go, /Back/)).toHaveAttribute('aria-disabled', 'true')
    expect(item(go, /Forward/)).toHaveAttribute('aria-disabled', 'true')
  })

  it('Help: opens the logs folder by name', async () => {
    const { openFolder } = renderWithStore(<App />)

    fireEvent.click(item(await openSubmenu('Help'), /Open logs folder/))

    expect(openFolder).toHaveBeenCalledWith('logs')
  })

  describe('Alt', () => {
    it('on its own opens the menu', async () => {
      renderWithStore(<App />)

      fireEvent.keyDown(window, { key: 'Alt', altKey: true })
      fireEvent.keyUp(window, { key: 'Alt' })

      expect(await screen.findByRole('menu', { name: 'Menu' })).toBeInTheDocument()
    })

    it('with a letter opens that menu: Alt+F → File', async () => {
      renderWithStore(<App />)

      fireEvent.keyDown(window, { key: 'Alt', altKey: true })
      fireEvent.keyDown(window, { key: 'f', altKey: true })

      expect(await screen.findByRole('menu', { name: 'File' })).toBeInTheDocument()
    })

    it('does nothing if another key came in between (Alt+Tab, Alt+←)', () => {
      renderWithStore(<App />)

      fireEvent.keyDown(window, { key: 'Alt', altKey: true })
      fireEvent.keyDown(window, { key: 'ArrowLeft', altKey: true })
      fireEvent.keyUp(window, { key: 'Alt' })

      expect(screen.queryByRole('menu', { name: 'Menu' })).not.toBeInTheDocument()
    })
  })

  describe('shortcuts', () => {
    it('Ctrl+Q quits, Ctrl+W closes the window, Ctrl+, opens Settings', async () => {
      const { quit, appWindow } = renderWithStore(<App />)

      fireEvent.keyDown(window, { key: 'q', ctrlKey: true })
      fireEvent.keyDown(window, { key: 'w', ctrlKey: true })
      fireEvent.keyDown(window, { key: ',', ctrlKey: true })

      expect(quit).toHaveBeenCalledOnce()
      expect(appWindow.close).toHaveBeenCalledOnce()
      expect(await screen.findByRole('dialog', { name: 'Settings' })).toBeInTheDocument()
    })
  })
})
