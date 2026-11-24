import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { Shell } from '@app/shell/Shell'
import { ModelButton } from '@app/features/models'
import { useUpdateChatMutation } from '@app/core/generated'
import { coreWrites } from '../../../fakeCoreHttp'
import { exampleConnection, renderWithStore } from '../../../renderWithStore'
import { selectExpandModel, selectModelsTab, selectSettingsSection } from '@app/store/uiSlice'
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
  tags: [],
  memory: null
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

  it('opens Settings on Models from "Manage models…" and closes the popover', async () => {
    const { store } = renderWithStore(<Shell />, {}, { models: [qwen] })
    // The chat's model is known once the list has arrived; "Manage models…" names it.
    await waitFor(() => expect(button()).toHaveAccessibleName(/^Model: Qwen3-8B,/))
    const popover = await openPopover()

    fireEvent.click(within(popover).getByRole('button', { name: 'Manage models…' }))

    expect(await screen.findByRole('heading', { level: 2, name: 'Models' })).toBeInTheDocument()
    expect(screen.queryByRole('dialog', { name: 'Models service' })).not.toBeInTheDocument()
    expect(selectSettingsSection(store.getState())).toBe('models')
    expect(selectModelsTab(store.getState())).toBe('installed')
    expect(selectExpandModel(store.getState())).toBe(qwen.id)
  })

  it('closes with Esc', async () => {
    renderWithStore(<Shell />, {}, { models: [qwen] })
    const popover = await openPopover()

    fireEvent.keyDown(popover, { key: 'Escape' })

    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Models service' })).not.toBeInTheDocument()
    )
  })

  it('shows the name on the button and the file id in its tooltip', async () => {
    renderWithStore(
      <Shell />,
      {},
      { coreState: ready, models: [{ ...qwen, name: 'Qwen3 8B', id: 'Qwen3-8B' }] }
    )

    await waitFor(() => expect(button()).toHaveAccessibleName('Model: Qwen3 8B, not loaded. Change model'))
    expect(button()).toHaveTextContent('Qwen3 8B')
    expect(screen.getByTitle('Qwen3-8B')).toBeInTheDocument()
  })

  it('lists chat models only, the chosen one selected, with no load state words or buttons', async () => {
    const embed: ModelInfo = { ...qwen, id: 'nomic-embed', name: 'Nomic Embed', kind: 'embedding' }
    const junk: ModelInfo = {
      ...qwen,
      id: 'junk',
      name: 'junk',
      kind: 'unreadable',
      error: 'not a GGUF file'
    }
    renderWithStore(
      <Shell />,
      {},
      {
        coreState: ready,
        models: [embed, { ...qwen, state: 'ready' }, { ...qwen, id: 'Gemma', name: 'Gemma' }, junk]
      }
    )
    await waitFor(() => expect(button()).toHaveAccessibleName('Model: Qwen3-8B, loaded. Change model'))
    const popover = await openPopover()

    const list = within(popover).getByRole('listbox', { name: 'Models' })
    expect(within(list).getAllByRole('option')).toHaveLength(2)
    expect(within(list).getByRole('option', { name: 'Qwen3-8B' })).toHaveAttribute('aria-selected', 'true')
    expect(within(list).getByRole('option', { name: 'Gemma' })).toHaveAttribute('aria-selected', 'false')
    expect(popover).not.toHaveTextContent(/Loaded|Ready —/)
    expect(within(popover).queryByRole('button', { name: /Load|Unload/ })).toBeNull()
  })

  it('says what is happening when there is no list: starting, or a problem', async () => {
    const { core } = renderWithStore(<Shell />, {}, { coreState: { status: 'starting' } })
    const popover = await openPopover()
    expect(popover).toHaveTextContent('Starting the models service…')

    core.emitState({ status: 'problem', reason: 'boom' })
    await waitFor(() => expect(popover).toHaveTextContent('Problem: boom'))
  })

  it("shows core's error in the option of a model that failed, and only the details that are known", async () => {
    renderWithStore(
      <Shell />,
      {},
      {
        coreState: ready,
        models: [
          { ...qwen, state: 'error', error: 'not enough memory' },
          {
            ...qwen,
            id: 'Full',
            name: 'Full',
            quant: 'Q4_K_M',
            context: { context: 32768 } as ModelInfo['context']
          },
          { ...qwen, id: 'Bare', name: 'Bare' }
        ]
      }
    )
    const popover = await openPopover()

    expect(await within(popover).findByRole('option', { name: 'Qwen3-8B' })).toHaveAccessibleDescription(
      'not enough memory'
    )
    expect(within(popover).getByRole('option', { name: 'Full' })).toHaveAccessibleDescription(
      'Q4_K_M · 5.0 GB · 32k context'
    )
    expect(within(popover).getByRole('option', { name: 'Bare' })).toHaveAccessibleDescription('5.0 GB')
  })

  it('has no service buttons: Restart, Open log, Model settings or Get more models', async () => {
    renderWithStore(<Shell />, {}, { coreState: ready, models: [qwen] })
    const popover = await openPopover()

    for (const name of ['Restart', 'Open log', 'Model settings…', 'Get more models…'])
      expect(within(popover).queryByRole('button', { name })).toBeNull()
  })

  it("sets a saved chat's model through core and closes, or shows why it could not", async () => {
    function Saved(): React.JSX.Element {
      const [update] = useUpdateChatMutation()
      return (
        <ModelButton
          model="Qwen3-8B"
          onPick={async (id) => {
            await update({ id: 'c1', body: { model: id } }).unwrap()
          }}
        />
      )
    }
    const other = { ...qwen, id: 'Gemma', name: 'Gemma' }
    const { coreHttp } = renderWithStore(<Saved />, {}, { coreState: ready, models: [qwen, other] })
    coreHttp.respond('PATCH', '/api/chats/c1', () => ({
      status: 404,
      body: { error: 'model_not_found', message: 'Gemma is no longer installed.' }
    }))
    const popover = await openPopover()

    fireEvent.click(await within(popover).findByRole('option', { name: 'Gemma' }))
    expect(await within(popover).findByRole('alert')).toHaveTextContent('Gemma is no longer installed.')

    coreHttp.respond('PATCH', '/api/chats/c1', () => ({
      status: 200,
      body: { chat: { id: 'c1', title: 't', titleSource: 'auto', model: 'Gemma', updatedAt: 0 }, seq: 0 }
    }))
    fireEvent.click(within(popover).getByRole('option', { name: 'Gemma' }))

    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Models service' })).not.toBeInTheDocument()
    )
    expect(coreWrites(coreHttp)).toContainEqual({
      method: 'PATCH',
      path: '/api/chats/c1',
      body: { model: 'Gemma' }
    })
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
    expect(popover).toHaveTextContent('No chat models found.')

    core.emitState({ status: 'problem', reason: 'boom' })
    await waitFor(() => expect(popover).not.toHaveTextContent('No chat models found.'))
  })
})
