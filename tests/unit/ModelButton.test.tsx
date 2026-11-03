import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { App } from '@renderer/App'
import { renderWithStore } from './renderWithStore'
import type { ModelInfo } from '../../src/shared/core'

const qwen: ModelInfo = { id: 'Qwen3-8B', state: 'stopped', busy: false, sizeBytes: 5 * 1024 ** 3 }
const ready = { status: 'ready', port: 1234, version: '1' } as const

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

  it('opens Settings on Models from "Model settings…" and closes the popover', async () => {
    renderWithStore(<App />)
    const popover = await openPopover()

    fireEvent.click(within(popover).getByRole('button', { name: 'Model settings…' }))

    expect(await screen.findByRole('heading', { level: 2, name: 'Models' })).toBeInTheDocument()
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

  it('lists the models and loads one', async () => {
    const { core } = renderWithStore(<App />, {}, { coreState: ready, models: [qwen] })
    const popover = await openPopover()

    fireEvent.click(await within(popover).findByRole('button', { name: 'Load Qwen3-8B' }))

    expect(core.load).toHaveBeenCalledWith('Qwen3-8B')
  })

  it('names the loaded model on the button and offers Unload', async () => {
    const { core } = renderWithStore(<App />, {}, { coreState: ready, models: [{ ...qwen, state: 'ready' }] })

    await waitFor(() => expect(button()).toHaveAccessibleName('Model: Qwen3-8B, Ready'))
    expect(button()).toHaveTextContent('Qwen3-8B')
    const popover = await openPopover()
    expect(popover).toHaveTextContent('Ready — Qwen3-8B loaded')

    fireEvent.click(within(popover).getByRole('button', { name: 'Unload Qwen3-8B' }))
    expect(core.unload).toHaveBeenCalledWith('Qwen3-8B')
  })

  it('says Loading while a model loads, and shows a failed request', async () => {
    const { core } = renderWithStore(
      <App />,
      {},
      { coreState: ready, models: [{ ...qwen, state: 'loading' }] }
    )
    await waitFor(() => expect(button()).toHaveAccessibleName('Model: Qwen3-8B, Loading'))

    core.emitModels([qwen])
    core.load.mockRejectedValueOnce(new Error("Error invoking remote method 'x': Error: out of memory"))
    const popover = await openPopover()
    fireEvent.click(within(popover).getByRole('button', { name: 'Load Qwen3-8B' }))

    expect(await within(popover).findByRole('alert')).toHaveTextContent('out of memory')
  })

  it('explains an empty list, and lists nothing while core is not ready', async () => {
    const { core } = renderWithStore(<App />, {}, { coreState: ready })
    const popover = await openPopover()
    expect(popover).toHaveTextContent('No models found')

    core.emitState({ status: 'problem', reason: 'boom' })
    await waitFor(() => expect(popover).not.toHaveTextContent('No models found'))
  })
})
