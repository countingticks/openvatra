import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { App } from '@renderer/App'
import { coreApi } from '@renderer/core/coreApi'
import { settingsOpened } from '@renderer/store/uiSlice'
import type { CoreState, ModelInfo } from '../../../src/shared/core'
import { defaultSettings, type ModelsSettings, type Settings } from '../../../src/shared/settings'
import { coreWrites } from '../fakeCoreHttp'
import { exampleConnection, renderWithStore } from '../renderWithStore'

const ready: CoreState = { status: 'ready', port: 1234, version: '1', connection: exampleConnection }
const chosen: ModelsSettings = {
  ...defaultSettings.models,
  llamaServerPath: 'C:\\llama\\llama-server.exe',
  modelsDir: 'D:\\models',
  showAdvanced: true
}
const qwen: ModelInfo = {
  id: 'Qwen3-8B-Q4_K_M',
  state: 'stopped',
  busy: false,
  sizeBytes: 5 * 1024 ** 3,
  kind: 'chat'
}
const nomic: ModelInfo = {
  id: 'nomic-embed',
  state: 'ready',
  busy: false,
  sizeBytes: 140 * 1024 ** 2,
  kind: 'embedding'
}

type Rendered = ReturnType<typeof renderWithStore>

/** Renders the app with Settings open on Models. */
async function openModels(
  models: Partial<ModelsSettings> = chosen,
  options: NonNullable<Parameters<typeof renderWithStore>[2]> = {}
): Promise<Rendered & { section: HTMLElement }> {
  // Most tests are about the advanced view, so it is on unless a test says otherwise.
  const rendered = renderWithStore(
    <App />,
    { models: { ...defaultSettings.models, showAdvanced: true, ...models } },
    options
  )
  act(() => {
    rendered.store.dispatch(settingsOpened('models'))
  })
  const advanced = models.showAdvanced ?? true
  const section = await screen.findByRole('region', {
    name: advanced ? 'Available models' : 'Installed models'
  })
  return { ...rendered, section }
}

describe('Settings → Models', () => {
  describe('paths', () => {
    it('shows both paths, or the default folder when none is chosen', async () => {
      await openModels(
        { llamaServerPath: 'C:\\llama\\llama-server.exe' },
        { coreState: { status: 'starting' } }
      )

      expect(screen.getByText('C:\\llama\\llama-server.exe')).toBeInTheDocument()
      expect(screen.getByText(/OpenVatra.Models folder/)).toBeInTheDocument()
    })

    it('shows the bundled build when no llama-server is chosen, with no "Use bundled" button', async () => {
      await openModels({ llamaServerPath: null })

      expect(await screen.findByText('Bundled (b12078, Vulkan)')).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Browse for llama-server.exe' })).toHaveTextContent(
        'Use my own…'
      )
      expect(screen.queryByRole('button', { name: 'Use bundled' })).not.toBeInTheDocument()
    })

    it('leaves the tag out of the bundled label when core has none', async () => {
      const { store } = await openModels(
        { llamaServerPath: null },
        { coreState: ready, engines: { tag: null } }
      )

      // "Bundled (Vulkan)" is also what shows before core answers, so wait for the answer first.
      await waitFor(() =>
        expect(coreApi.endpoints.getEngines.select()(store.getState()).data?.bundled.tag).toBeNull()
      )
      expect(screen.getByText('Bundled (Vulkan)')).toBeInTheDocument()
    })

    it('"Use bundled" asks main to forget the custom path, and shows the bundled build again', async () => {
      const { useBundledLlama } = await openModels({ llamaServerPath: 'C:\\llama\\llama-server.exe' })

      fireEvent.click(screen.getByRole('button', { name: 'Use bundled' }))

      expect(await screen.findByText('Bundled (b12078, Vulkan)')).toBeInTheDocument()
      expect(useBundledLlama).toHaveBeenCalledOnce()
      expect(screen.queryByRole('button', { name: 'Use bundled' })).not.toBeInTheDocument()
    })

    it('says so when "Use bundled" can’t be saved', async () => {
      const { useBundledLlama } = await openModels({ llamaServerPath: 'C:\\llama\\llama-server.exe' })
      useBundledLlama.mockRejectedValueOnce(new Error('disk full'))

      fireEvent.click(screen.getByRole('button', { name: 'Use bundled' }))

      expect(await screen.findByRole('alert')).toHaveTextContent('That setting could not be saved.')
    })

    it('Browse… asks main to pick, and shows what main saved', async () => {
      const { pick } = await openModels({})
      const saved: Settings = {
        ...defaultSettings,
        models: { ...defaultSettings.models, modelsDir: 'E:\\gguf' }
      }
      pick.mockResolvedValueOnce(saved)

      fireEvent.click(screen.getByRole('button', { name: 'Browse for Models folder' }))

      expect(pick).toHaveBeenCalledWith('modelsDir')
      expect(await screen.findByText('E:\\gguf')).toBeInTheDocument()
    })

    it('changes nothing when the dialog is cancelled, and says so when saving fails', async () => {
      const { pick } = await openModels({}, { coreState: { status: 'starting' } })

      fireEvent.click(screen.getByRole('button', { name: 'Browse for llama-server.exe' }))
      await waitFor(() => expect(pick).toHaveBeenCalledWith('llamaServer'))
      expect(screen.getByText(/OpenVatra.Models folder/)).toBeInTheDocument()

      pick.mockRejectedValueOnce(new Error('disk full'))
      fireEvent.click(screen.getByRole('button', { name: 'Browse for llama-server.exe' }))
      expect(await screen.findByRole('alert')).toHaveTextContent('That path could not be saved.')
    })
  })

  describe('default and advanced views', () => {
    const catalog = {
      diskFreeBytes: null,
      recommended: null,
      entries: [
        {
          id: 'small-3b',
          name: 'Small 3B',
          summary: 's',
          tags: [],
          licence: 'Apache-2.0',
          sizeBytes: 2 * 1024 ** 3,
          needsGB: 3,
          rank: 1,
          fit: 'fits' as const,
          installed: true,
          diskShortBytes: 0
        },
        {
          id: 'big-9b',
          name: 'Big 9B',
          summary: 's',
          tags: [],
          licence: 'Apache-2.0',
          sizeBytes: 6 * 1024 ** 3,
          needsGB: 8,
          rank: 2,
          fit: 'fits' as const,
          installed: false,
          diskShortBytes: 0
        }
      ]
    }

    it('shows only the simple things until "Show advanced" is on', async () => {
      await openModels({ showAdvanced: false }, { coreState: ready, models: [qwen], setup: { catalog } })

      expect(await screen.findByText('Small 3B')).toBeInTheDocument()
      expect(screen.queryByText('Big 9B')).not.toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Get more models…' })).toBeInTheDocument()
      expect(screen.getByRole('radiogroup', { name: 'Unload models after' })).toBeInTheDocument()
      expect(screen.queryByRole('button', { name: 'Browse for llama-server.exe' })).not.toBeInTheDocument()
      expect(screen.queryByRole('button', { name: 'Restart' })).not.toBeInTheDocument()
      expect(screen.queryByText('Qwen3-8B-Q4_K_M')).not.toBeInTheDocument()
    })

    it('"Show advanced" is saved and reveals the engine, the log and every model file', async () => {
      const { saveSettings } = await openModels(
        { showAdvanced: false },
        { coreState: ready, models: [qwen], setup: { catalog } }
      )

      fireEvent.click(screen.getByRole('switch', { name: 'Show advanced' }))

      await waitFor(() => expect(saveSettings).toHaveBeenCalledWith({ models: { showAdvanced: true } }))
      expect(screen.getByRole('button', { name: 'Browse for llama-server.exe' })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Restart' })).toBeInTheDocument()
      expect(await screen.findByText('Qwen3-8B-Q4_K_M')).toBeInTheDocument()
    })

    it('removes a downloaded model only after confirming', async () => {
      const { coreHttp } = await openModels({ showAdvanced: false }, { coreState: ready, setup: { catalog } })

      fireEvent.click(await screen.findByRole('button', { name: 'Remove Small 3B' }))
      expect(coreWrites(coreHttp)).toEqual([])
      fireEvent.click(screen.getByRole('button', { name: 'Remove it' }))

      await waitFor(() =>
        expect(coreWrites(coreHttp)).toEqual([
          { method: 'POST', path: '/api/catalog/small-3b/remove', body: undefined }
        ])
      )
    })

    it("shows core's reason when the model can't be removed", async () => {
      const { coreHttp } = await openModels({ showAdvanced: false }, { coreState: ready, setup: { catalog } })
      coreHttp.respond('POST', '/api/catalog/small-3b/remove', () => ({
        status: 500,
        body: { error: 'trash_failed', message: 'Windows could not move the model to the Recycle Bin.' }
      }))

      fireEvent.click(await screen.findByRole('button', { name: 'Remove Small 3B' }))
      fireEvent.click(screen.getByRole('button', { name: 'Remove it' }))

      expect(await screen.findByRole('alert')).toHaveTextContent(
        'Windows could not move the model to the Recycle Bin.'
      )
    })

    it('says so when nothing is installed', async () => {
      await openModels({ showAdvanced: false }, { coreState: ready })
      expect(await screen.findByText(/No models yet/)).toBeInTheDocument()
    })
  })

  it('saves "Unload models after", with Never as null', async () => {
    const { saveSettings } = await openModels()
    const group = screen.getByRole('radiogroup', { name: 'Unload models after' })
    expect(within(group).getByRole('radio', { name: '15 min' })).toBeChecked()

    fireEvent.click(within(group).getByRole('radio', { name: 'Never' }))

    await waitFor(() => expect(saveSettings).toHaveBeenCalledWith({ models: { idleUnloadMinutes: null } }))
    expect(within(group).getByRole('radio', { name: 'Never' })).toBeChecked()
  })

  describe('empty and problem states', () => {
    it('says the service is starting', async () => {
      const { section } = await openModels(chosen, { coreState: { status: 'starting' } })
      expect(within(section).getByRole('status')).toHaveTextContent('Starting the models service…')
    })

    it('shows the service problem instead of the list', async () => {
      const { section } = await openModels(
        {},
        { coreState: { status: 'problem', reason: 'core exited (code 1)' } }
      )
      expect(await within(section).findByRole('alert')).toHaveTextContent(
        'The models service has a problem: core exited (code 1)'
      )
    })

    it('says when the folder has no models', async () => {
      const { section } = await openModels(chosen, { coreState: ready })
      expect(await within(section).findByRole('status')).toHaveTextContent('No models found')
    })

    it('restarts the service and opens the log', async () => {
      const { core, section } = await openModels()

      fireEvent.click(within(section).getByRole('button', { name: 'Restart' }))
      fireEvent.click(within(section).getByRole('button', { name: 'Open log' }))

      expect(core.restart).toHaveBeenCalledOnce()
      expect(core.openLog).toHaveBeenCalledOnce()
    })
  })

  describe('the model list', () => {
    const junk: ModelInfo = {
      id: 'broken',
      state: 'stopped',
      busy: false,
      sizeBytes: 10,
      kind: 'unreadable',
      error: 'not a GGUF file'
    }

    it('groups models by kind, with unreadable files last, no state and no Load or Unload', async () => {
      const { core } = await openModels(chosen, { coreState: ready, models: [junk, nomic, qwen] })

      const chat = await screen.findByRole('region', { name: 'Chat models' })
      const embedding = screen.getByRole('region', { name: 'Embedding models' })
      const unusable = screen.getByRole('region', { name: "Files that can't be used" })
      expect(within(chat).getByText('5.0 GB')).toBeInTheDocument()
      expect(within(chat).queryByText(nomic.id)).not.toBeInTheDocument()
      expect(within(embedding).getByText('140 MB')).toBeInTheDocument()
      expect(within(unusable).getByText('not a GGUF file')).toBeInTheDocument()
      expect(within(unusable).queryByRole('button')).not.toBeInTheDocument()
      expect(chat.compareDocumentPosition(embedding) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
      expect(embedding.compareDocumentPosition(unusable) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
      expect(screen.queryByText(/Loaded|Not loaded/)).not.toBeInTheDocument()
      expect(screen.queryByRole('button', { name: /^(Load|Unload) / })).not.toBeInTheDocument()

      core.emitModels([qwen])

      // The list now arrives over core's stream, so the change shows a moment later.
      await waitFor(() => expect(screen.queryByText(/nomic-embed/)).not.toBeInTheDocument())
      expect(screen.queryByRole('region', { name: 'Embedding models' })).not.toBeInTheDocument()
    })

    it('offers only embedding models, Automatic first, and saves the choice', async () => {
      const second: ModelInfo = { ...nomic, id: 'qwen3-embedding' }
      const { saveSettings } = await openModels(chosen, { coreState: ready, models: [qwen, nomic, second] })
      const select = await screen.findByRole('combobox', { name: 'Embedding model' })
      expect(select).toHaveValue('')
      expect(
        within(select)
          .getAllByRole('option')
          .map((option) => option.textContent)
      ).toEqual(['Automatic (nomic-embed)', 'nomic-embed', 'qwen3-embedding'])
      expect(screen.queryByRole('alert')).not.toBeInTheDocument()

      fireEvent.change(select, { target: { value: 'qwen3-embedding' } })
      await waitFor(() =>
        expect(saveSettings).toHaveBeenLastCalledWith({ models: { embeddingModel: 'qwen3-embedding' } })
      )
      expect(select).toHaveValue('qwen3-embedding')

      fireEvent.change(select, { target: { value: '' } })
      await waitFor(() => expect(saveSettings).toHaveBeenLastCalledWith({ models: { embeddingModel: null } }))
    })

    it('is disabled with a hint when there is no embedding model', async () => {
      await openModels(chosen, { coreState: ready, models: [qwen] })
      const select = await screen.findByRole('combobox', { name: 'Embedding model' })

      expect(select).toBeDisabled()
      expect(select).toHaveDisplayValue('Not found')
    })

    it('warns about a chat model chosen for embeddings and resets it', async () => {
      const { saveSettings } = await openModels(
        { ...chosen, embeddingModel: qwen.id },
        { coreState: ready, models: [qwen, nomic] }
      )
      const select = await screen.findByRole('combobox', { name: 'Embedding model' })
      const alert = screen.getByRole('alert')

      expect(alert).toHaveTextContent(`${qwen.id} is a chat model, so Automatic is used`)
      expect(select).toHaveValue('')

      fireEvent.click(within(alert).getByRole('button', { name: 'Reset' }))

      await waitFor(() => expect(saveSettings).toHaveBeenLastCalledWith({ models: { embeddingModel: null } }))
    })

    it('also warns when the chosen model is gone', async () => {
      await openModels({ ...chosen, embeddingModel: 'deleted' }, { coreState: ready, models: [nomic] })

      expect(await screen.findByRole('alert')).toHaveTextContent("deleted isn't an available embedding model")
    })
  })

  describe('per-model options', () => {
    async function openOptions(
      options: ModelsSettings['options'] = {}
    ): Promise<Rendered & { group: HTMLElement }> {
      const rendered = await openModels({ ...chosen, options }, { coreState: ready, models: [qwen, nomic] })
      const toggle = await screen.findByRole('button', { name: `Options for ${qwen.id}` })
      expect(toggle).toHaveAttribute('aria-expanded', 'false')
      fireEvent.click(toggle)
      expect(toggle).toHaveAttribute('aria-expanded', 'true')
      return { ...rendered, group: screen.getByRole('group', { name: `Options for ${qwen.id}` }) }
    }

    it("keeps one model's options open at a time, across groups", async () => {
      await openModels(chosen, { coreState: ready, models: [qwen, nomic] })
      const first = await screen.findByRole('button', { name: `Options for ${qwen.id}` })
      const second = screen.getByRole('button', { name: `Options for ${nomic.id}` })

      fireEvent.click(first)
      fireEvent.click(second)

      expect(first).toHaveAttribute('aria-expanded', 'false')
      expect(second).toHaveAttribute('aria-expanded', 'true')
      expect(screen.getAllByRole('group')).toHaveLength(1)
    })

    it('saves the arguments when the box loses focus, keeping other models’ options', async () => {
      const { saveSettings, group } = await openOptions({ 'nomic-embed': { args: '-ngl 0' } })
      const args = within(group).getByLabelText('Arguments')

      fireEvent.change(args, { target: { value: '  -c 131072 --alias "my qwen"\n' } })
      expect(saveSettings).not.toHaveBeenCalled()
      fireEvent.blur(args)

      await waitFor(() =>
        expect(saveSettings).toHaveBeenCalledWith({
          models: {
            options: { 'nomic-embed': { args: '-ngl 0' }, [qwen.id]: { args: '-c 131072 --alias "my qwen"' } }
          }
        })
      )
    })

    it('refuses a flag OpenVatra sets itself, and saves nothing', async () => {
      const { saveSettings, group } = await openOptions()
      const args = within(group).getByLabelText('Arguments')

      fireEvent.change(args, { target: { value: '-c 4096 --port 9000' } })
      fireEvent.blur(args)

      expect(args).toHaveAttribute('aria-invalid', 'true')
      expect(args).toHaveAccessibleDescription("--port is set by OpenVatra and can't be changed.")
      expect(saveSettings).not.toHaveBeenCalled()
    })

    it('drops the model’s entry when the box is emptied', async () => {
      const { saveSettings, group } = await openOptions({ [qwen.id]: { args: '-c 8192' } })
      const args = within(group).getByLabelText('Arguments')
      expect(args).toHaveValue('-c 8192')

      fireEvent.change(args, { target: { value: ' ' } })
      fireEvent.blur(args)

      await waitFor(() => expect(saveSettings).toHaveBeenCalledWith({ models: { options: {} } }))
    })
  })
})
