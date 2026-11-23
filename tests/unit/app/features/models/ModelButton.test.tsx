import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { Shell } from '@app/shell/Shell'
import { ModelButton } from '@app/features/models'
import { defaultEngineSettings } from '@app/features/models/modelSettings'
import { coreWrites } from '../../../fakeCoreHttp'
import { exampleConnection, renderWithStore } from '../../../renderWithStore'
import type { ModelInfo } from '@app/core/types'

const qwen: ModelInfo = {
  id: 'Qwen3-8B',
  state: 'stopped',
  busy: false,
  sizeBytes: 5 * 1024 ** 3,
  kind: 'chat',
  context: null,
  moe: false,
  name: 'Qwen3-8B',
  quant: null,
  tags: []
}
const ready = { status: 'ready', port: 1234, version: '1', connection: exampleConnection } as const

const button = (): HTMLElement => screen.getByRole('button', { name: /^Model:/ })

async function openPopover(): Promise<HTMLElement> {
  fireEvent.click(button())
  return screen.findByRole('dialog', { name: 'Models service' })
}

describe('model button', () => {
  it("names a new chat's model with its load state in words", async () => {
    const { core } = renderWithStore(<Shell />, {}, { coreState: ready, models: [qwen] })

    await waitFor(() => expect(button()).toHaveAccessibleName('Model: Qwen3-8B, not loaded. Change model'))
    expect(button()).toHaveTextContent('Qwen3-8B')

    core.emitModels([{ ...qwen, state: 'ready' }])

    await waitFor(() => expect(button()).toHaveAccessibleName('Model: Qwen3-8B, loaded. Change model'))
  })

  it('reads starting, then follows every state change', async () => {
    const { core } = renderWithStore(<Shell />)
    expect(button()).toHaveAccessibleName('Model: no model, starting. Change model')

    core.emitState({ status: 'problem', reason: 'llama-server.exe not found' })

    expect(button()).toHaveAccessibleName('Model: no model, problem. Change model')
    const popover = await openPopover()
    expect(popover).toHaveTextContent('Problem: llama-server.exe not found')
  })

  it('restarts the service and opens the log', async () => {
    const { core } = renderWithStore(<Shell />, {}, { models: [qwen] })
    const popover = await openPopover()

    fireEvent.click(within(popover).getByRole('button', { name: 'Restart' }))
    fireEvent.click(within(popover).getByRole('button', { name: 'Open log' }))

    expect(core.restart).toHaveBeenCalledOnce()
    expect(core.openLog).toHaveBeenCalledOnce()
  })

  it('opens Settings on Models from "Model settings…" and closes the popover', async () => {
    renderWithStore(<Shell />, {}, { models: [qwen] })
    const popover = await openPopover()

    fireEvent.click(within(popover).getByRole('button', { name: 'Model settings…' }))

    expect(await screen.findByRole('heading', { level: 2, name: 'Models' })).toBeInTheDocument()
    expect(screen.queryByRole('dialog', { name: 'Models service' })).not.toBeInTheDocument()
  })

  it('closes with Esc', async () => {
    renderWithStore(<Shell />, {}, { models: [qwen] })
    const popover = await openPopover()

    fireEvent.keyDown(popover, { key: 'Escape' })

    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Models service' })).not.toBeInTheDocument()
    )
  })

  it('lists the models and loads one through core', async () => {
    const { coreHttp } = renderWithStore(<Shell />, {}, { coreState: ready, models: [qwen] })
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
    renderWithStore(<Shell />, {}, { coreState: ready, models: [embed, qwen, junk] })
    const popover = await openPopover()

    expect(await within(popover).findByRole('button', { name: 'Load Qwen3-8B' })).toBeInTheDocument()
    expect(within(popover).queryByText('nomic-embed')).not.toBeInTheDocument()
    expect(within(popover).queryByText('junk')).not.toBeInTheDocument()
    // A loaded embedding model is not "the model" the button names.
    expect(button()).toHaveAccessibleName('Model: Qwen3-8B, not loaded. Change model')
  })

  it("marks the chat's model in the list, says which is loaded, and unloads it from its button", async () => {
    const { coreHttp } = renderWithStore(
      <Shell />,
      {},
      {
        coreState: ready,
        models: [
          { ...qwen, state: 'ready' },
          { ...qwen, id: 'Gemma' }
        ]
      }
    )

    await waitFor(() => expect(button()).toHaveAccessibleName('Model: Qwen3-8B, loaded. Change model'))
    expect(button()).toHaveTextContent('Qwen3-8B')
    const popover = await openPopover()
    expect(popover).not.toHaveTextContent('Ready —')

    expect(within(popover).getByRole('button', { name: 'Use Qwen3-8B' })).toHaveAttribute(
      'aria-current',
      'true'
    )
    expect(within(popover).getByRole('button', { name: 'Use Gemma' })).not.toHaveAttribute('aria-current')
    expect(within(popover).getAllByText('Loaded')).toHaveLength(1)
    expect(within(popover).getByRole('button', { name: 'Load Gemma' })).toBeEnabled()

    fireEvent.click(within(popover).getByRole('button', { name: 'Unload Qwen3-8B' }))
    await waitFor(() =>
      expect(coreWrites(coreHttp)).toEqual([
        { method: 'POST', path: '/api/models/Qwen3-8B/unload', body: undefined }
      ])
    )
  })

  it('disables only the Load button of a loading model, and shows no state words', async () => {
    renderWithStore(<Shell />, {}, { coreState: ready, models: [{ ...qwen, state: 'loading' }] })
    await waitFor(() => expect(button()).toHaveAccessibleName('Model: Qwen3-8B, loading. Change model'))
    const popover = await openPopover()

    expect(within(popover).getByRole('button', { name: 'Load Qwen3-8B' })).toBeDisabled()
    expect(within(popover).getByRole('button', { name: 'Use Qwen3-8B' })).toBeEnabled()
    expect(popover).not.toHaveTextContent(/Loaded|Not loaded|Loading…/)
  })

  it('says what is happening when there is no list: starting, or a problem', async () => {
    const { core } = renderWithStore(<Shell />, {}, { coreState: { status: 'starting' } })
    const popover = await openPopover()
    expect(popover).toHaveTextContent('Starting the models service…')

    core.emitState({ status: 'problem', reason: 'boom' })
    await waitFor(() => expect(popover).toHaveTextContent('Problem: boom'))
  })

  it("shows core's error under the model's name", async () => {
    renderWithStore(
      <Shell />,
      {},
      { coreState: ready, models: [{ ...qwen, state: 'error', error: 'not enough memory' }] }
    )
    const popover = await openPopover()

    expect(await within(popover).findByRole('alert')).toHaveTextContent('not enough memory')
    expect(within(popover).getByRole('button', { name: 'Load Qwen3-8B' })).toBeEnabled()
  })

  it("says Loading while a model loads, and shows core's reason when the request fails", async () => {
    const { coreHttp } = renderWithStore(<Shell />, {}, { coreState: ready, models: [qwen] })
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
      <Shell />,
      {},
      {
        coreState: ready,
        engines: { cuda: 'ready' },
        engineSettings: { build: 'cuda' },
        models: [{ ...qwen, state: 'error', error: 'The model did not start.' }]
      }
    )
    const popover = await openPopover()

    fireEvent.click(await within(popover).findByRole('button', { name: 'Use the standard engine' }))

    await waitFor(() =>
      expect(coreWrites(coreHttp)).toEqual([
        {
          method: 'PUT',
          path: '/api/config/engine.llamaserver',
          body: { rev: 1, value: { ...defaultEngineSettings, build: 'bundled' } }
        }
      ])
    )
  })

  it('explains an empty list, and lists nothing while core is not ready', async () => {
    // In the Chat tab the welcome card stands in for an empty list; the button on its own still explains one.
    const { core } = renderWithStore(
      <ModelButton model={null} onPick={async () => {}} />,
      {},
      {
        coreState: ready
      }
    )
    const popover = await openPopover()
    expect(popover).toHaveTextContent('No models found')

    core.emitState({ status: 'problem', reason: 'boom' })
    await waitFor(() => expect(popover).not.toHaveTextContent('No models found'))
  })
})

describe('model button on a host without service actions', () => {
  it('has no Restart and no Open log without restart and openLog', async () => {
    // With no chat model, the welcome card replaces the Chat tab, button and all.
    renderWithStore(<Shell />, {}, { omit: ['restart', 'openLog'], models: [qwen] })
    const popover = await openPopover()

    expect(within(popover).queryByRole('button', { name: 'Restart' })).toBeNull()
    expect(within(popover).queryByRole('button', { name: 'Open log' })).toBeNull()
  })

  it('keeps Open log when only restart is missing', async () => {
    renderWithStore(<Shell />, {}, { omit: ['restart'], models: [qwen] })
    const popover = await openPopover()

    expect(within(popover).queryByRole('button', { name: 'Restart' })).toBeNull()
    expect(within(popover).getByRole('button', { name: 'Open log' })).toBeInTheDocument()
  })
})
