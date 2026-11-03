import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { App } from '@renderer/App'
import { renderWithStore } from './renderWithStore'

const button = (): HTMLElement => screen.getByRole('button', { name: /^Model:/ })

async function openPopover(): Promise<HTMLElement> {
  fireEvent.click(button())
  return screen.findByRole('dialog', { name: 'Models service' })
}

describe('model button', () => {
  it('sits in the Chat tab and says "No model" with the state in words', async () => {
    renderWithStore(<App />, {}, { coreState: { status: 'ready', port: 1234, version: '1' } })

    expect(button()).toHaveTextContent('No model')
    await waitFor(() => expect(button()).toHaveAccessibleName('Model: no model, Ready'))
  })

  it('starts as Starting and follows every state change', async () => {
    const { core } = renderWithStore(<App />)
    expect(button()).toHaveAccessibleName('Model: no model, Starting')

    core.emitState({ status: 'problem', reason: 'llama-server.exe not found' })

    expect(button()).toHaveAccessibleName('Model: no model, Problem')
    const popover = await openPopover()
    expect(popover).toHaveTextContent('Problem: llama-server.exe not found')
  })

  it('restarts the service and opens the log', async () => {
    const { core } = renderWithStore(<App />)
    const popover = await openPopover()

    fireEvent.click(within(popover).getByRole('button', { name: 'Restart' }))
    fireEvent.click(within(popover).getByRole('button', { name: 'Open log' }))

    expect(core.restart).toHaveBeenCalledOnce()
    expect(core.openLog).toHaveBeenCalledOnce()
  })

  it('opens Settings from "Model settings…" and closes the popover', async () => {
    renderWithStore(<App />)
    const popover = await openPopover()

    fireEvent.click(within(popover).getByRole('button', { name: 'Model settings…' }))

    expect(await screen.findByRole('heading', { name: 'General' })).toBeInTheDocument()
    expect(screen.queryByRole('dialog', { name: 'Models service' })).not.toBeInTheDocument()
  })

  it('closes with Esc', async () => {
    renderWithStore(<App />)
    const popover = await openPopover()

    fireEvent.keyDown(popover, { key: 'Escape' })

    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Models service' })).not.toBeInTheDocument()
    )
  })
})
