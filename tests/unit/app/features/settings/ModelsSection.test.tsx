import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { Shell } from '@app/shell/Shell'
import { coreApi } from '@app/core/coreApi'
import type { LlamaCppSettings, LlamaServerSettings } from '@app/core/generated'
import { defaultEngineSettings, defaultLlamacppSettings } from '@app/features/models/modelSettings'
import { settingsOpened } from '@app/store/uiSlice'
import type { CoreState } from '@shared/core'
import type { ModelInfo } from '@app/core/types'
import { coreWrites, fitQueries, type FakeCoreHttp } from '../../../fakeCoreHttp'
import { exampleConnection, renderWithStore } from '../../../renderWithStore'

const ready: CoreState = { status: 'ready', port: 1234, version: '1', connection: exampleConnection }
/** The two window flags that sit beside core's models section in a test's arguments. */
type Preferences = Partial<LlamaCppSettings> & {
  engineSettings?: Partial<LlamaServerSettings>
  showAdvanced?: boolean
  cudaOfferDismissed?: boolean
}

const chosen: Preferences = {
  engineSettings: { path: 'C:\\llama\\llama-server.exe' },
  modelsDir: 'D:\\models',
  showAdvanced: true
}
const qwen: ModelInfo = {
  id: 'Qwen3-8B-Q4_K_M',
  state: 'stopped',
  busy: false,
  sizeBytes: 5 * 1024 ** 3,
  kind: 'chat',
  context: null,
  moe: false
}
const nomic: ModelInfo = {
  id: 'nomic-embed',
  state: 'ready',
  busy: false,
  sizeBytes: 140 * 1024 ** 2,
  kind: 'embedding',
  context: null,
  moe: false
}

type Rendered = ReturnType<typeof renderWithStore>

/** The value each PUT of the provider section carried, in order. */
const putValues = (http: FakeCoreHttp): LlamaCppSettings[] =>
  coreWrites(http)
    .filter((write) => write.method === 'PUT' && write.path === '/api/config/provider.llamacpp')
    .map((write) => (write.body as { value: LlamaCppSettings }).value)

/** The value each PUT of the engine section carried, in order. */
const enginePutValues = (http: FakeCoreHttp): LlamaServerSettings[] =>
  coreWrites(http)
    .filter((write) => write.method === 'PUT' && write.path === '/api/config/engine.llamaserver')
    .map((write) => (write.body as { value: LlamaServerSettings }).value)

/** Plays core's config.changed for the provider section at this rev. */
const configChanged = (http: FakeCoreHttp, rev: number): void =>
  act(() => {
    http.push({
      data: {
        seq: rev,
        time: 1,
        stream: 'system',
        type: 'config.changed',
        v: 1,
        data: { section: 'provider.llamacpp', rev }
      }
    })
  })

/**
 * Renders the app with Settings open on Models. The window's preferences go to the saved settings, the rest is
 * core's models section.
 */
async function openModels(
  models: Preferences = chosen,
  options: NonNullable<Parameters<typeof renderWithStore>[2]> = {}
): Promise<Rendered & { section: HTMLElement }> {
  // Most tests are about the advanced view, so it is on unless a test says otherwise.
  const { showAdvanced = true, cudaOfferDismissed = false, engineSettings, ...core } = models
  const rendered = renderWithStore(
    <Shell />,
    { showAdvancedModels: showAdvanced, cudaOfferDismissed },
    { llamacppSettings: core, engineSettings, ...options }
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
  describe('on a host without some members', () => {
    it('has no Change… or Use my own… without files', async () => {
      await openModels({}, { coreState: ready, omit: ['files'] })

      expect(screen.queryByRole('button', { name: 'Change…' })).toBeNull()
      expect(screen.queryByRole('button', { name: 'Use my own…' })).toBeNull()
    })

    it('has no Restart or Open log without restart and openLog', async () => {
      await openModels({}, { coreState: ready, omit: ['restart', 'openLog'] })

      expect(screen.queryByRole('button', { name: 'Restart' })).toBeNull()
      expect(screen.queryByRole('button', { name: 'Open log' })).toBeNull()
    })
  })

  describe('paths', () => {
    it("shows both of core's paths, or the default folder when none is chosen", async () => {
      await openModels({ engineSettings: { path: 'C:\\llama\\llama-server.exe' } }, { coreState: ready })

      expect(await screen.findByText('C:\\llama\\llama-server.exe')).toBeInTheDocument()
      expect(screen.getByText('The OpenVatra\\Models folder in your user folder')).toBeInTheDocument()
    })

    it("shows core's models folder", async () => {
      await openModels({ modelsDir: 'D:\\models' }, { coreState: ready })

      expect(await screen.findByText('D:\\models')).toBeInTheDocument()
    })

    it('shows the bundled build when no llama-server is chosen, with no "Use bundled" button', async () => {
      await openModels({ engineSettings: { path: null } })

      expect(await screen.findByText('Bundled (b12078, Vulkan)')).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Browse for llama-server.exe' })).toHaveTextContent(
        'Use my own…'
      )
      expect(screen.queryByRole('button', { name: 'Use bundled' })).not.toBeInTheDocument()
    })

    it('leaves the tag out of the bundled label when core has none', async () => {
      const { store } = await openModels(
        { engineSettings: { path: null } },
        { coreState: ready, engines: { tag: null } }
      )

      // "Bundled (Vulkan)" is also what shows before core answers, so wait for the answer first.
      await waitFor(() =>
        expect(coreApi.endpoints.getEngines.select()(store.getState()).data?.bundled.tag).toBeNull()
      )
      expect(screen.getByText('Bundled (Vulkan)')).toBeInTheDocument()
    })

    it('"Use bundled" asks core to forget the custom path, and shows the bundled build again', async () => {
      const { coreHttp } = await openModels(
        { engineSettings: { path: 'C:\\llama\\llama-server.exe' } },
        { coreState: ready }
      )

      fireEvent.click(await screen.findByRole('button', { name: 'Use bundled' }))

      expect(await screen.findByText('Bundled (b12078, Vulkan)')).toBeInTheDocument()
      expect(enginePutValues(coreHttp)).toEqual([{ ...defaultEngineSettings, path: null }])
      expect(putValues(coreHttp)).toEqual([])
      expect(screen.queryByRole('button', { name: 'Use bundled' })).not.toBeInTheDocument()
    })

    it("shows core's message when it refuses a change", async () => {
      const { coreHttp } = await openModels(
        { engineSettings: { path: 'C:\\llama\\llama-server.exe' } },
        { coreState: ready }
      )
      coreHttp.respond('PUT', '/api/config/engine.llamaserver', () => ({
        status: 400,
        body: { error: 'invalid_config', message: 'path must be absolute' }
      }))

      fireEvent.click(await screen.findByRole('button', { name: 'Use bundled' }))

      expect(await screen.findByRole('alert')).toHaveTextContent('path must be absolute')
      expect(screen.getByText('C:\\llama\\llama-server.exe')).toBeInTheDocument()
    })

    it('Browse… asks main to pick, and shows the folder core then reports', async () => {
      const { coreHttp, pick } = await openModels({}, { coreState: ready })
      await waitFor(() => expect(coreHttp.openStreams()).toBe(1))
      pick.mockResolvedValueOnce(true)

      fireEvent.click(screen.getByRole('button', { name: 'Browse for Models folder' }))
      expect(pick).toHaveBeenCalledWith('modelsDir')
      coreHttp.setConfig('provider.llamacpp', {
        rev: 2,
        value: { ...defaultLlamacppSettings, modelsDir: 'E:\\gguf' }
      })
      configChanged(coreHttp, 2)

      expect(await screen.findByText('E:\\gguf')).toBeInTheDocument()
    })

    it('shows no alert when the path was saved', async () => {
      const { pick } = await openModels({}, { coreState: ready })
      pick.mockResolvedValueOnce(true)

      fireEvent.click(screen.getByRole('button', { name: 'Browse for Models folder' }))

      await waitFor(() => expect(pick).toHaveBeenCalledWith('modelsDir'))
      expect(screen.queryByRole('alert')).not.toBeInTheDocument()
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

      await waitFor(() => expect(saveSettings).toHaveBeenCalledWith({ showAdvancedModels: true }))
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

  it('saves "Unload models after" in core, with Never as null', async () => {
    const { coreHttp } = await openModels(chosen, { coreState: ready })
    const group = screen.getByRole('radiogroup', { name: 'Unload models after' })
    expect(within(group).getByRole('radio', { name: '15 min' })).toBeChecked()

    fireEvent.click(within(group).getByRole('radio', { name: '1 hour' }))
    await waitFor(() => expect(within(group).getByRole('radio', { name: '1 hour' })).toBeChecked())
    fireEvent.click(within(group).getByRole('radio', { name: 'Never' }))

    await waitFor(() => expect(within(group).getByRole('radio', { name: 'Never' })).toBeChecked())
    expect(putValues(coreHttp).map((value) => value.idleUnloadMinutes)).toEqual([60, null])
    expect(enginePutValues(coreHttp)).toEqual([])
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
      error: 'not a GGUF file',
      context: null,
      moe: false
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
      const { coreHttp } = await openModels(chosen, { coreState: ready, models: [qwen, nomic, second] })
      const select = await screen.findByRole('combobox', { name: 'Embedding model' })
      expect(select).toHaveValue('')
      expect(
        within(select)
          .getAllByRole('option')
          .map((option) => option.textContent)
      ).toEqual(['Automatic (nomic-embed)', 'nomic-embed', 'qwen3-embedding'])
      expect(screen.queryByRole('alert')).not.toBeInTheDocument()

      fireEvent.change(select, { target: { value: 'qwen3-embedding' } })
      await waitFor(() => expect(select).toHaveValue('qwen3-embedding'))

      fireEvent.change(select, { target: { value: '' } })
      await waitFor(() => expect(putValues(coreHttp)).toHaveLength(2))
      expect(putValues(coreHttp).map((value) => value.embeddingModel)).toEqual(['qwen3-embedding', null])
    })

    it('is disabled with a hint when there is no embedding model', async () => {
      await openModels(chosen, { coreState: ready, models: [qwen] })
      const select = await screen.findByRole('combobox', { name: 'Embedding model' })

      expect(select).toBeDisabled()
      expect(select).toHaveDisplayValue('Not found')
    })

    it('warns about a chat model chosen for embeddings and resets it', async () => {
      const { coreHttp } = await openModels(
        { ...chosen, embeddingModel: qwen.id },
        { coreState: ready, models: [qwen, nomic] }
      )
      const select = await screen.findByRole('combobox', { name: 'Embedding model' })
      const alert = await screen.findByRole('alert')

      expect(alert).toHaveTextContent(`${qwen.id} is a chat model, so Automatic is used`)
      expect(select).toHaveValue('')

      fireEvent.click(within(alert).getByRole('button', { name: 'Reset' }))

      await waitFor(() => expect(putValues(coreHttp)).toHaveLength(1))
      expect(putValues(coreHttp)[0]?.embeddingModel).toBeNull()
    })

    it('also warns when the chosen model is gone', async () => {
      await openModels({ ...chosen, embeddingModel: 'deleted' }, { coreState: ready, models: [nomic] })

      expect(await screen.findByRole('alert')).toHaveTextContent("deleted isn't an available embedding model")
    })
  })

  describe('the context size on a row', () => {
    it('shows the size a chat model loads with, and nothing for an embedding model', async () => {
      const sized: ModelInfo = {
        ...qwen,
        context: {
          context: 32768,
          capped: false,
          fit: 'fits',
          placement: 'gpu',
          ramBytes: 0,
          vramBytes: 1,
          tokensPerSecond: 0,
          source: 'estimate'
        }
      }
      await openModels(chosen, { coreState: ready, models: [sized, nomic] })

      const size = await screen.findByTitle('Loads with 32,768 tokens of context')
      expect(size).toHaveTextContent('32K')
      expect(screen.getAllByTitle(/^Loads with/)).toHaveLength(1)
    })
  })

  describe('per-model options', () => {
    async function openOptions(
      options: LlamaCppSettings['options'] = {}
    ): Promise<Rendered & { group: HTMLElement }> {
      const rendered = await openModels({ ...chosen, options }, { coreState: ready, models: [qwen, nomic] })
      // The arguments box starts from what core has, so wait for core's answer (its folder shows) first.
      await screen.findByText('D:\\models')
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
      const { coreHttp, group } = await openOptions({ 'nomic-embed': { args: '--jinja' } })
      const args = within(group).getByLabelText('Arguments')

      fireEvent.change(args, { target: { value: '  --temp 0.7 --alias "my qwen"\n' } })
      expect(putValues(coreHttp)).toEqual([])
      fireEvent.blur(args)

      await waitFor(() => expect(putValues(coreHttp)).toHaveLength(1))
      expect(putValues(coreHttp)[0]?.options).toEqual({
        'nomic-embed': { args: '--jinja' },
        [qwen.id]: { args: '--temp 0.7 --alias "my qwen"' }
      })
    })

    it('keeps the stored context and placement when the arguments change', async () => {
      const { coreHttp, group } = await openOptions({
        [qwen.id]: { args: '--jinja', context: 8192, placement: 'cpu' }
      })
      const args = within(group).getByLabelText('Arguments')

      fireEvent.change(args, { target: { value: '--temp 0.7' } })
      fireEvent.blur(args)

      await waitFor(() => expect(putValues(coreHttp)).toHaveLength(1))
      expect(putValues(coreHttp)[0]?.options).toEqual({
        [qwen.id]: { args: '--temp 0.7', context: 8192, placement: 'cpu' }
      })
    })

    describe('context size and placement', () => {
      const choice = (context: number): NonNullable<ModelInfo['context']> => ({
        context,
        capped: false,
        fit: 'fits',
        placement: 'gpu',
        ramBytes: 0,
        vramBytes: 1,
        tokensPerSecond: 0,
        source: 'estimate'
      })
      const sized: ModelInfo = { ...qwen, context: choice(32768) }

      /** Picks an option of the open menu; Base UI selects on the pointer's release, not on a bare click. */
      async function choose(name: string): Promise<void> {
        const option = await screen.findByRole('option', { name })
        fireEvent.pointerDown(option)
        fireEvent.mouseDown(option)
        fireEvent.pointerUp(option)
        fireEvent.mouseUp(option)
        fireEvent.click(option)
      }

      async function openSized(
        options: LlamaCppSettings['options'] = {},
        model: ModelInfo = sized
      ): Promise<Rendered & { group: HTMLElement }> {
        const rendered = await openModels(
          { ...chosen, options },
          { coreState: ready, models: [model, nomic] }
        )
        await screen.findByText('D:\\models')
        fireEvent.click(await screen.findByRole('button', { name: `Options for ${model.id}` }))
        return { ...rendered, group: screen.getByRole('group', { name: `Options for ${model.id}` }) }
      }

      describe('the hint', () => {
        it('asks core about Auto and shows the answer, and asks nothing for an embedding model', async () => {
          const { coreHttp, group } = await openSized()

          expect(
            await within(group).findByText(/^32K tokens · fits on your GPU \(4\.0 GB of /)
          ).toBeInTheDocument()
          expect(fitQueries(coreHttp)).toEqual([{ context: 'auto', placement: 'auto' }])

          fireEvent.click(screen.getByRole('button', { name: `Options for ${nomic.id}` }))
          await screen.findByRole('group', { name: `Options for ${nomic.id}` })
          expect(fitQueries(coreHttp)).toHaveLength(1)
        })

        it('asks about a typed size once, 300 ms after the last keystroke', async () => {
          const { coreHttp, group } = await openSized({ [qwen.id]: { context: 32768 } })
          await within(group).findByText(/fits on your GPU/)
          const input = within(group).getByLabelText('Context size in tokens')
          const before = fitQueries(coreHttp).length

          vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
          try {
            fireEvent.change(input, { target: { value: '6553' } })
            act(() => void vi.advanceTimersByTime(200))
            fireEvent.change(input, { target: { value: '65536' } })
            act(() => void vi.advanceTimersByTime(299))
            expect(fitQueries(coreHttp)).toHaveLength(before)
            act(() => void vi.advanceTimersByTime(1))
          } finally {
            vi.useRealTimers()
          }

          await waitFor(() => expect(fitQueries(coreHttp)).toHaveLength(before + 1))
          expect(fitQueries(coreHttp).at(-1)).toEqual({ context: '65536', placement: 'auto' })
        })

        it('asks at once when the placement changes', async () => {
          const { coreHttp, group } = await openSized()
          await within(group).findByText(/fits on your GPU/)

          fireEvent.click(within(group).getByRole('combobox', { name: 'Placement' }))
          await choose('CPU only')

          await waitFor(() =>
            expect(fitQueries(coreHttp).at(-1)).toEqual({ context: 'auto', placement: 'cpu' })
          )
        })
        it('empties the hint while the new answer is missing, instead of keeping the old one', async () => {
          const { coreHttp, group } = await openSized()
          await within(group).findByText(/fits on your GPU/)
          coreHttp.respond('GET', `/api/models/${qwen.id}/fit`, () => ({
            status: 500,
            body: { error: 'internal', message: 'no answer' }
          }))

          fireEvent.click(within(group).getByRole('combobox', { name: 'Placement' }))
          await choose('CPU only')

          await waitFor(() => expect(fitQueries(coreHttp).at(-1)?.placement).toBe('cpu'))
          await waitFor(() => expect(within(group).queryByText(/fits on your GPU/)).not.toBeInTheDocument())
        })
      })

      it('shows Auto for both on a chat model, and neither on an embedding model', async () => {
        const { group } = await openSized()

        expect(within(group).getByRole('radio', { name: 'Auto' })).toBeChecked()
        expect(within(group).getByRole('combobox', { name: 'Placement' })).toHaveTextContent('Auto')
        expect(within(group).queryByLabelText('Context size in tokens')).not.toBeInTheDocument()

        fireEvent.click(screen.getByRole('button', { name: `Options for ${nomic.id}` }))
        const embedding = screen.getByRole('group', { name: `Options for ${nomic.id}` })
        expect(within(embedding).queryByText('Context')).not.toBeInTheDocument()
        expect(within(embedding).queryByText('Placement')).not.toBeInTheDocument()
      })

      it("starts Custom from the model's auto size, and saves a typed size on Enter", async () => {
        const { coreHttp, group } = await openSized()

        fireEvent.click(within(group).getByRole('radio', { name: 'Custom' }))
        await waitFor(() => expect(putValues(coreHttp)).toHaveLength(1))
        expect(putValues(coreHttp)[0]?.options).toEqual({ [qwen.id]: { context: 32768 } })

        const input = await within(group).findByLabelText('Context size in tokens')
        expect(input).toHaveValue('32768')
        fireEvent.change(input, { target: { value: '131072' } })
        fireEvent.keyDown(input, { key: 'Enter' })

        await waitFor(() => expect(putValues(coreHttp)).toHaveLength(2))
        expect(putValues(coreHttp)[1]?.options).toEqual({ [qwen.id]: { context: 131072 } })
      })

      it('explains a size out of range, saves nothing, and Escape puts the stored size back', async () => {
        const { coreHttp, group } = await openSized({ [qwen.id]: { context: 8192 } })
        const input = within(group).getByLabelText('Context size in tokens')

        fireEvent.change(input, { target: { value: '1000' } })
        fireEvent.keyDown(input, { key: 'Enter' })

        expect(input).toHaveAttribute('aria-invalid', 'true')
        expect(input).toHaveAccessibleDescription('A whole number from 2048 to 1048576.')
        expect(putValues(coreHttp)).toEqual([])

        fireEvent.keyDown(input, { key: 'Escape' })
        expect(input).toHaveValue('8192')
        expect(input).not.toHaveAttribute('aria-invalid')
      })

      it('Auto drops the size and keeps the arguments', async () => {
        const { coreHttp, group } = await openSized({ [qwen.id]: { args: '--jinja', context: 8192 } })

        fireEvent.click(within(group).getByRole('radio', { name: 'Auto' }))

        await waitFor(() => expect(putValues(coreHttp)).toHaveLength(1))
        expect(putValues(coreHttp)[0]?.options).toEqual({ [qwen.id]: { args: '--jinja' } })
      })

      it('offers "Experts in RAM" only for a mixture-of-experts model', async () => {
        const plain = await openSized()
        fireEvent.click(within(plain.group).getByRole('combobox', { name: 'Placement' }))
        expect(await screen.findByRole('option', { name: 'CPU only' })).toBeInTheDocument()
        expect(screen.queryByRole('option', { name: 'Experts in RAM' })).not.toBeInTheDocument()
        plain.unmount()

        const moe = await openSized({}, { ...sized, moe: true })
        fireEvent.click(within(moe.group).getByRole('combobox', { name: 'Placement' }))
        expect(await screen.findByRole('option', { name: 'Experts in RAM' })).toBeInTheDocument()
      })

      it('saves a placement, and Auto removes it', async () => {
        const { coreHttp, group } = await openSized()

        fireEvent.click(within(group).getByRole('combobox', { name: 'Placement' }))
        await choose('CPU only')
        await waitFor(() => expect(putValues(coreHttp)).toHaveLength(1))
        expect(putValues(coreHttp)[0]?.options).toEqual({ [qwen.id]: { placement: 'cpu' } })

        await waitFor(() =>
          expect(within(group).getByRole('combobox', { name: 'Placement' })).toHaveTextContent('CPU only')
        )
        fireEvent.click(within(group).getByRole('combobox', { name: 'Placement' }))
        await choose('Auto')
        await waitFor(() => expect(putValues(coreHttp)).toHaveLength(2))
        expect(putValues(coreHttp)[1]?.options).toEqual({})
      })
    })

    it('refuses a flag OpenVatra sets itself, and saves nothing', async () => {
      const { coreHttp, group } = await openOptions()
      const args = within(group).getByLabelText('Arguments')

      fireEvent.change(args, { target: { value: '--temp 0.7 --port 9000' } })
      fireEvent.blur(args)

      expect(args).toHaveAttribute('aria-invalid', 'true')
      expect(args).toHaveAccessibleDescription("--port is set by OpenVatra and can't be changed.")
      expect(putValues(coreHttp)).toEqual([])
    })

    it('refuses the size and placement flags, which OpenVatra sets itself', async () => {
      const { coreHttp, group } = await openOptions()
      const args = within(group).getByLabelText('Arguments')

      fireEvent.change(args, { target: { value: '-ngl 20' } })
      fireEvent.blur(args)

      expect(args).toHaveAttribute('aria-invalid', 'true')
      expect(args).toHaveAccessibleDescription("-ngl is set by OpenVatra and can't be changed.")
      expect(putValues(coreHttp)).toEqual([])
    })

    it('drops the model’s entry when the box is emptied', async () => {
      const { coreHttp, group } = await openOptions({ [qwen.id]: { args: '--jinja' } })
      const args = within(group).getByLabelText('Arguments')
      expect(args).toHaveValue('--jinja')

      fireEvent.change(args, { target: { value: ' ' } })
      fireEvent.blur(args)

      await waitFor(() => expect(putValues(coreHttp)).toHaveLength(1))
      expect(putValues(coreHttp)[0]?.options).toEqual({})
    })
  })
})
