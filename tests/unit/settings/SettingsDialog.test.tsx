import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { App } from '@renderer/App'
import { exampleLocations, renderWithStore } from '../renderWithStore'

const gear = (): HTMLElement => screen.getByRole('button', { name: 'Settings' })
const dialog = (): HTMLElement => screen.getByRole('dialog', { name: 'Settings' })
const group = (name: string): HTMLElement => within(dialog()).getByRole('radiogroup', { name })

async function openSettings(): Promise<HTMLElement> {
  fireEvent.click(gear())
  return screen.findByRole('dialog', { name: 'Settings' })
}

describe('Settings dialog', () => {
  describe('opening and closing', () => {
    it('opens from the gear at the bottom of the sidebar, over the current tab', async () => {
      renderWithStore(<App />, { lastTab: 'code' })
      expect(gear()).toHaveAttribute('aria-haspopup', 'dialog')

      await openSettings()

      // The tab stays open underneath, but a modal dialog hides it from screen readers while it's open.
      expect(screen.getByRole('heading', { level: 1, name: 'Code', hidden: true })).toBeInTheDocument()
      expect(screen.queryByRole('heading', { level: 1, name: 'Code' })).not.toBeInTheDocument()
    })

    it('opens with Ctrl+,', async () => {
      renderWithStore(<App />)

      fireEvent.keyDown(window, { key: ',', ctrlKey: true })

      expect(await screen.findByRole('dialog', { name: 'Settings' })).toBeInTheDocument()
    })

    it('closes with its ✕, and gives focus back to the gear', async () => {
      renderWithStore(<App />)
      gear().focus()
      const open = await openSettings()

      fireEvent.click(within(open).getByRole('button', { name: 'Close settings' }))

      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
      await waitFor(() => expect(gear()).toHaveFocus())
    })

    it('closes with Esc', async () => {
      renderWithStore(<App />)
      const open = await openSettings()

      fireEvent.keyDown(open, { key: 'Escape' })

      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    })

    it('shows General now, and where later sections will go', async () => {
      renderWithStore(<App />)
      const open = await openSettings()
      const sections = within(open).getByRole('navigation', { name: 'Settings sections' })

      expect(within(sections).getByRole('button', { name: 'General' })).toHaveAttribute(
        'aria-current',
        'page'
      )
      expect(within(sections).getByRole('button', { name: /Models/ })).toBeDisabled()
      expect(within(open).getByRole('heading', { level: 2, name: 'General' })).toBeInTheDocument()
    })
  })

  describe('Theme', () => {
    it('offers System, Light and Dark, showing the saved one', async () => {
      renderWithStore(<App />, { theme: 'light' })
      await openSettings()

      const names = within(group('Theme'))
        .getAllByRole('radio')
        .map((radio) => radio.textContent)
      expect(names).toEqual(['System', 'Light', 'Dark'])
      expect(within(group('Theme')).getByRole('radio', { name: 'Light' })).toBeChecked()
    })

    it('saves the theme the user picks', async () => {
      const { saveSettings } = renderWithStore(<App />)
      await openSettings()

      fireEvent.click(within(group('Theme')).getByRole('radio', { name: 'Dark' }))

      await waitFor(() => expect(within(group('Theme')).getByRole('radio', { name: 'Dark' })).toBeChecked())
      await vi.waitFor(() => expect(saveSettings).toHaveBeenCalledWith({ theme: 'dark' }))
    })
  })

  describe('Start with Windows', () => {
    it('is a switch, off by default, explained by its hint', async () => {
      renderWithStore(<App />)
      await openSettings()
      const toggle = within(dialog()).getByRole('switch', { name: 'Start with Windows' })

      expect(toggle).not.toBeChecked()
      expect(toggle).toHaveAccessibleDescription(/starts in the tray/i)
    })

    it('saves the change when switched on', async () => {
      const { saveSettings } = renderWithStore(<App />)
      await openSettings()

      fireEvent.click(within(dialog()).getByRole('switch', { name: 'Start with Windows' }))

      await vi.waitFor(() => expect(saveSettings).toHaveBeenCalledWith({ startWithWindows: true }))
    })
  })

  describe('When I close the window', () => {
    it('keeps running in the tray by default, and saves the choice to quit', async () => {
      const { saveSettings } = renderWithStore(<App />)
      await openSettings()
      const close = group('When I close the window')

      expect(within(close).getByRole('radio', { name: 'Keep in tray' })).toBeChecked()
      fireEvent.click(within(close).getByRole('radio', { name: 'Quit' }))

      await vi.waitFor(() => expect(saveSettings).toHaveBeenCalledWith({ closeAction: 'quit' }))
    })
  })

  describe('File locations', () => {
    it('shows where the settings file and the logs are', async () => {
      renderWithStore(<App />)
      await openSettings()

      expect(await within(dialog()).findByText(exampleLocations.settingsFile)).toBeInTheDocument()
      expect(within(dialog()).getByText(exampleLocations.logsFolder)).toBeInTheDocument()
    })

    it('opens each folder by name, never by path', async () => {
      const { openFolder } = renderWithStore(<App />)
      await openSettings()

      fireEvent.click(within(dialog()).getByRole('button', { name: 'Open the settings file folder' }))
      fireEvent.click(within(dialog()).getByRole('button', { name: 'Open the logs folder' }))

      await vi.waitFor(() => expect(openFolder.mock.calls).toEqual([['settings'], ['logs']]))
    })

    it('says so when a folder cannot be opened', async () => {
      const { openFolder } = renderWithStore(<App />)
      openFolder.mockRejectedValueOnce(new Error('gone'))
      await openSettings()

      fireEvent.click(within(dialog()).getByRole('button', { name: 'Open the logs folder' }))

      expect(await within(dialog()).findByRole('alert')).toHaveTextContent('could not be opened')
    })
  })
})
