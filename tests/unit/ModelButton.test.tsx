import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { App } from '@renderer/App'
import { defaultCoreModels } from '@renderer/core/modelSettings'
import { coreWrites } from './fakeCoreHttp'
import { exampleConnection, renderWithStore } from './renderWithStore'
import type { ModelInfo } from '../../src/shared/core'

const qwen: ModelInfo = {
  id: 'Qwen3-8B',
  state: 'stopped',
  busy: false,
  sizeBytes: 5 * 1024 ** 3,
  kind: 'chat'
}
const ready = { status: 'ready', port: 1234, version: '1', connection: exampleConnection } as const

const button = (): HTMLElement => screen.getByRole('button', { name: /^Model:/ })

async function openPopover(): Promise<HTMLElement> {
  fireEvent.click(button())
  return screen.findByRole('dialog', { name: 'Models service' })
}

describe('model button', () => {
  it('sits in the Chat tab and says "No model" with the state in words', async () => {
    renderWithStore(
      <App />,
      {},
      { coreState: { status: 'ready', port: 1234, version: '1', connection: exampleConnection } }
    )

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

  it('lists the models and loads one through core', async () => {
    const { coreHttp } = renderWithStore(<App />, {}, { coreState: ready, models: [qwen] })
    const popover = await openPopover()

    fireEvent.click(await within(popover).findByRole('button', { name: 'Load Qwen3-8B' }))

    await waitFor(() =>
      expect(coreWrites(coreHttp)).toEqual([
        { method: 'POST', path: '/api/models/Qwen3-8B/load', body: undefined }
      ])
    )
  })

  it('lists chat models only: embedding models and unreadable files load on demand or not at all', async () => {
    const embed: ModelInfo = { ...qwen, id: 'nomic-embed', kind: 'embedding', state: 'ready' }
    const junk: ModelInfo = { ...qwen, id: 'junk', kind: 'unreadable', error: 'not a GGUF file' }
    renderWithStore(<App />, {}, { coreState: ready, models: [embed, qwen, junk] })
    const popover = await openPopover()

    expect(await within(popover).findByRole('button', { name: 'Load Qwen3-8B' })).toBeInTheDocument()
    expect(within(popover).queryByText('nomic-embed')).not.toBeInTheDocument()
    expect(within(popover).queryByText('junk')).not.toBeInTheDocument()
    // A loaded embedding model is not "the model" the button names.
    expect(button()).toHaveAccessibleName('Model: no model, Ready')
  })

  it('names the loaded model on the button, highlights its row and unloads it on click', async () => {
    const { coreHttp } = renderWithStore(
      <App />,
      {},
      {
        coreState: ready,
        models: [
          { ...qwen, state: 'ready' },
          { ...qwen, id: 'Gemma' }
        ]
      }
    )

    await waitFor(() => expect(button()).toHaveAccessibleName('Model: Qwen3-8B, Ready'))
    expect(button()).toHaveTextContent('Qwen3-8B')
    const popover = await openPopover()
    expect(popover).not.toHaveTextContent('Ready —')

    const loaded = within(popover).getByRole('button', { name: 'Unload Qwen3-8B' })
    expect(loaded).toHaveAttribute('aria-current', 'true')
    expect(loaded).toHaveClass('bg-success/10')
    expect(within(popover).getByRole('button', { name: 'Load Gemma' })).not.toHaveAttribute('aria-current')

    fireEvent.click(loaded)
    await waitFor(() =>
      expect(coreWrites(coreHttp)).toEqual([
        { method: 'POST', path: '/api/models/Qwen3-8B/unload', body: undefined }
      ])
    )
  })

  it('shows a disabled spinner row while a model loads, and no state words', async () => {
    renderWithStore(<App />, {}, { coreState: ready, models: [{ ...qwen, state: 'loading' }] })
    await waitFor(() => expect(button()).toHaveAccessibleName('Model: Qwen3-8B, Loading'))
    const popover = await openPopover()

    expect(within(popover).getByRole('button', { name: 'Loading Qwen3-8B' })).toBeDisabled()
    expect(popover).not.toHaveTextContent(/Loaded|Not loaded|Loading…/)
  })

  it('says what is happening when there is no list: starting, or a problem', async () => {
    const { core } = renderWithStore(<App />, {}, { coreState: { status: 'starting' } })
    const popover = await openPopover()
    expect(popover).toHaveTextContent('Starting the models service…')

    core.emitState({ status: 'problem', reason: 'boom' })
    await waitFor(() => expect(popover).toHaveTextContent('Problem: boom'))
  })

  it("shows core's error under the model's name", async () => {
    renderWithStore(
      <App />,
      {},
      { coreState: ready, models: [{ ...qwen, state: 'error', error: 'not enough memory' }] }
    )
    const popover = await openPopover()

    expect(await within(popover).findByRole('alert')).toHaveTextContent('not enough memory')
    expect(within(popover).getByRole('button', { name: 'Load Qwen3-8B' })).toBeEnabled()
  })

  it("says Loading while a model loads, and shows core's reason when the request fails", async () => {
    const { coreHttp } = renderWithStore(<App />, {}, { coreState: ready, models: [qwen] })
    coreHttp.respond('POST', '/api/models/Qwen3-8B/load', () => ({
      status: 503,
      body: { error: 'model_load_failed', message: 'out of memory' }
    }))
    const popover = await openPopover()
    fireEvent.click(await within(popover).findByRole('button', { name: 'Load Qwen3-8B' }))

    expect(await within(popover).findByRole('alert')).toHaveTextContent('out of memory')
  })

  it('switches to the standard engine from a model that failed on the faster one', async () => {
    const { coreHttp } = renderWithStore(
      <App />,
      {},
      {
        coreState: ready,
        engines: { cuda: 'ready' },
        modelSettings: { engine: 'cuda' },
        models: [{ ...qwen, state: 'error', error: 'The model did not start.' }]
      }
    )
    const popover = await openPopover()

    fireEvent.click(await within(popover).findByRole('button', { name: 'Use the standard engine' }))

    await waitFor(() =>
      expect(coreWrites(coreHttp)).toEqual([
        {
          method: 'PUT',
          path: '/api/config/models',
          body: { rev: 1, value: { ...defaultCoreModels, engine: 'bundled' } }
        }
      ])
    )
  })

  it('explains an empty list, and lists nothing while core is not ready', async () => {
    const { core } = renderWithStore(<App />, {}, { coreState: ready })
    const popover = await openPopover()
    expect(popover).toHaveTextContent('No models found')

    core.emitState({ status: 'problem', reason: 'boom' })
    await waitFor(() => expect(popover).not.toHaveTextContent('No models found'))
  })
})
