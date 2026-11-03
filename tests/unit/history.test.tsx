import { fireEvent, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { App } from '@renderer/App'
import { renderWithStore } from './renderWithStore'

const bar = (): HTMLElement => screen.getByRole('banner')
const back = (): HTMLElement => within(bar()).getByRole('button', { name: 'Back' })
const forward = (): HTMLElement => within(bar()).getByRole('button', { name: 'Forward' })
const openTab = (name: string): void => {
  fireEvent.click(within(screen.getByRole('navigation', { name: 'Main' })).getByRole('button', { name }))
}
const heading = (name: string): HTMLElement => screen.getByRole('heading', { level: 1, name })

describe('back and forward', () => {
  it('sit after the sidebar toggle, dimmed while there is nowhere to go', () => {
    renderWithStore(<App />)

    const names = within(bar())
      .getAllByRole('button')
      .map((button) => button.getAttribute('aria-label'))
    expect(names.slice(0, 4)).toEqual(['Menu', 'Sidebar', 'Back', 'Forward'])
    expect(back()).toBeDisabled()
    expect(forward()).toBeDisabled()
  })

  it('Back returns to the tab you came from, Forward goes there again', () => {
    renderWithStore(<App />)
    openTab('Code')

    fireEvent.click(back())
    expect(heading('Chat')).toBeInTheDocument()
    expect(forward()).toBeEnabled()

    fireEvent.click(forward())
    expect(heading('Code')).toBeInTheDocument()
    expect(forward()).toBeDisabled()
  })

  it('Alt+← and Alt+→ do the same from anywhere', () => {
    renderWithStore(<App />)
    openTab('Automations')

    fireEvent.keyDown(window, { key: 'ArrowLeft', altKey: true })
    expect(heading('Chat')).toBeInTheDocument()

    fireEvent.keyDown(window, { key: 'ArrowRight', altKey: true })
    expect(heading('Automations')).toBeInTheDocument()
  })

  it('a plain arrow key does not navigate', () => {
    renderWithStore(<App />)
    openTab('Code')

    fireEvent.keyDown(window, { key: 'ArrowLeft' })

    expect(heading('Code')).toBeInTheDocument()
  })

  it('the menu Go → Back works too', async () => {
    renderWithStore(<App />)
    openTab('Code')

    fireEvent.click(screen.getByRole('button', { name: 'Menu' }))
    const root = await screen.findByRole('menu', { name: 'Menu' })
    fireEvent.click(within(root).getByRole('menuitem', { name: 'Go' }))
    const go = await screen.findByRole('menu', { name: 'Go' })
    fireEvent.click(within(go).getByRole('menuitem', { name: /Back/ }))

    expect(await screen.findByRole('heading', { level: 1, name: 'Chat' })).toBeInTheDocument()
  })
})
