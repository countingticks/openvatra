import { fireEvent, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { App } from '@renderer/App'
import { exampleLocations, renderWithStore } from '../renderWithStore'

const general = (): HTMLElement => screen.getByRole('region', { name: 'General' })
const group = (name: string): HTMLElement => within(general()).getByRole('radiogroup', { name })

describe('Settings → General', () => {
  it('has a Settings page with a General section', () => {
    renderWithStore(<App />, { lastTab: 'settings' })

    expect(screen.getByRole('heading', { level: 1, name: 'Settings' })).toBeInTheDocument()
    expect(general()).toBeInTheDocument()
  })

  describe('Theme', () => {
    it('offers System, Light and Dark, showing the saved one', () => {
      renderWithStore(<App />, { lastTab: 'settings', theme: 'light' })
      const theme = group('Theme')

      const names = within(theme)
        .getAllByRole('radio')
        .map((radio) => radio.getAttribute('aria-label') ?? radio.closest('label')?.textContent)
      expect(names).toEqual(['System', 'Light', 'Dark'])
      expect(within(theme).getByRole('radio', { name: 'Light' })).toBeChecked()
    })

    it('saves the theme the user picks', async () => {
      const { saveSettings } = renderWithStore(<App />, { lastTab: 'settings' })

      fireEvent.click(within(group('Theme')).getByRole('radio', { name: 'Dark' }))

      expect(within(group('Theme')).getByRole('radio', { name: 'Dark' })).toBeChecked()
      await vi.waitFor(() => expect(saveSettings).toHaveBeenCalledWith({ theme: 'dark' }))
    })
  })

  describe('Start with Windows', () => {
    it('is a switch, off by default, explained by its hint', () => {
      renderWithStore(<App />, { lastTab: 'settings' })
      const toggle = screen.getByRole('switch', { name: 'Start with Windows' })

      expect(toggle).not.toBeChecked()
      expect(toggle).toHaveAccessibleDescription(/starts in the tray/i)
    })

    it('saves the change when switched on', async () => {
      const { saveSettings } = renderWithStore(<App />, { lastTab: 'settings' })

      fireEvent.click(screen.getByRole('switch', { name: 'Start with Windows' }))

      expect(screen.getByRole('switch', { name: 'Start with Windows' })).toBeChecked()
      await vi.waitFor(() => expect(saveSettings).toHaveBeenCalledWith({ startWithWindows: true }))
    })
  })

  describe('When I close the window', () => {
    it('keeps running in the tray by default', () => {
      renderWithStore(<App />, { lastTab: 'settings' })

      expect(
        within(group('When I close the window')).getByRole('radio', { name: 'Keep running in the tray' })
      ).toBeChecked()
    })

    it('saves the choice to quit instead', async () => {
      const { saveSettings } = renderWithStore(<App />, { lastTab: 'settings' })

      fireEvent.click(within(group('When I close the window')).getByRole('radio', { name: 'Quit OpenVatra' }))

      await vi.waitFor(() => expect(saveSettings).toHaveBeenCalledWith({ closeAction: 'quit' }))
    })
  })

  describe('File locations', () => {
    it('shows where the settings file and the logs are', async () => {
      renderWithStore(<App />, { lastTab: 'settings' })

      expect(await screen.findByText(exampleLocations.settingsFile)).toBeInTheDocument()
      expect(screen.getByText(exampleLocations.logsFolder)).toBeInTheDocument()
    })

    it('opens each folder by name, never by path', async () => {
      const { openFolder } = renderWithStore(<App />, { lastTab: 'settings' })

      fireEvent.click(screen.getByRole('button', { name: 'Open the settings file folder' }))
      fireEvent.click(screen.getByRole('button', { name: 'Open the logs folder' }))

      await vi.waitFor(() => expect(openFolder.mock.calls).toEqual([['settings'], ['logs']]))
    })

    it('says so when a folder cannot be opened', async () => {
      const { openFolder } = renderWithStore(<App />, { lastTab: 'settings' })
      openFolder.mockRejectedValueOnce(new Error('gone'))

      fireEvent.click(screen.getByRole('button', { name: 'Open the logs folder' }))

      expect(await screen.findByRole('alert')).toHaveTextContent('could not be opened')
    })
  })
})
