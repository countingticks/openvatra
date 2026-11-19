import { fireEvent, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { Shell } from '@app/shell/Shell'
import { renderWithStore } from '../../renderWithStore'

const titleBar = (): HTMLElement => screen.getByRole('banner')
const windowButton = (name: string): HTMLElement => within(titleBar()).getByRole('button', { name })

describe('title bar', () => {
  it('has the menu, the sidebar toggle, back, forward and the three window buttons', () => {
    renderWithStore(<Shell />)

    const names = within(titleBar())
      .getAllByRole('button')
      .map((button) => button.getAttribute('aria-label'))
    expect(names).toEqual(['Menu', 'Sidebar', 'Back', 'Forward', 'Minimize', 'Maximize', 'Close'])
  })

  it('sends each window button to main', () => {
    const { appWindow } = renderWithStore(<Shell />)

    fireEvent.click(windowButton('Minimize'))
    fireEvent.click(windowButton('Maximize'))
    fireEvent.click(windowButton('Close'))

    expect(appWindow.minimize).toHaveBeenCalledOnce()
    expect(appWindow.toggleMaximize).toHaveBeenCalledOnce()
    expect(appWindow.close).toHaveBeenCalledOnce()
  })

  it('shows Restore when the window opens maximized', async () => {
    renderWithStore(<Shell />, {}, { maximized: true })

    expect(await within(titleBar()).findByRole('button', { name: 'Restore' })).toBeInTheDocument()
  })

  it('follows maximize changes it did not cause (double-click on the bar, Aero Snap)', () => {
    const { appWindow } = renderWithStore(<Shell />)

    appWindow.emitMaximized(true)
    expect(windowButton('Restore')).toBeInTheDocument()

    appWindow.emitMaximized(false)
    expect(windowButton('Maximize')).toBeInTheDocument()
  })

  it('stops listening to main once it is gone', () => {
    const { appWindow, unmount } = renderWithStore(<Shell />)
    expect(appWindow.listeners()).toBe(1)

    unmount()

    expect(appWindow.listeners()).toBe(0)
  })
})

describe('title bar on a host without a window', () => {
  it('has no Minimize, Maximize or Close buttons', () => {
    renderWithStore(<Shell />, {}, { omit: ['window'] })

    for (const name of ['Minimize', 'Maximize', 'Restore', 'Close']) {
      expect(within(titleBar()).queryByRole('button', { name })).toBeNull()
    }
  })
})
