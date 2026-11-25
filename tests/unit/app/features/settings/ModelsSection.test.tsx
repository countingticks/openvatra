import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { coreApi } from '@app/core/coreApi'
import type { LlamaServerSettings } from '@app/core/generated'
import { defaultEngineSettings, defaultLlamacppSettings } from '@app/features/models/modelSettings'
import type { ModelInfo } from '@app/core/types'
import { Shell } from '@app/shell/Shell'
import { settingsOpened } from '@app/store/uiSlice'
import { coreWrites, type FakeCoreHttp } from '../../../fakeCoreHttp'
import {
  chosen,
  nomic,
  openModels,
  putValues,
  qwen,
  ready,
  type Preferences
} from '../models/openModelsSection'
import { renderWithStore } from '../../../renderWithStore'

/** Settings on Models with Advanced already open, unless the test's preferences say otherwise. */
const openAdvanced = (
  models: Preferences = {},
  options: Parameters<typeof openModels>[1] = {}
): ReturnType<typeof openModels> => openModels({ showAdvanced: true, ...models }, options)

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

/** A catalog with one model the user has and one to get. */
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

describe('Settings → Models', () => {
  describe('on a host without some members', () => {
    it('has no Change… or Use my own… without files', async () => {
      await openAdvanced({}, { coreState: ready, omit: ['files'] })

      expect(screen.queryByRole('button', { name: 'Change…' })).toBeNull()
      expect(screen.queryByRole('button', { name: 'Use my own…' })).toBeNull()
    })

    it('has no Restart or Open log without restart and openLog', async () => {
      await openAdvanced({}, { coreState: ready, omit: ['restart', 'openLog'] })

      expect(screen.queryByRole('button', { name: 'Restart' })).toBeNull()
      expect(screen.queryByRole('button', { name: 'Open log' })).toBeNull()
    })
  })

  describe('paths', () => {
    it("shows both of core's paths, or the default folder when none is chosen", async () => {
      await openAdvanced({ engineSettings: { path: 'C:\\llama\\llama-server.exe' } }, { coreState: ready })

      expect(await screen.findByText('C:\\llama\\llama-server.exe')).toBeInTheDocument()
      expect(screen.getByText('The OpenVatra\\Models folder in your user folder')).toBeInTheDocument()
    })

    it("shows core's models folder", async () => {
      await openAdvanced({ modelsDir: 'D:\\models' }, { coreState: ready })

      expect(await screen.findByText('D:\\models')).toBeInTheDocument()
    })

    it('shows the bundled build when no llama-server is chosen, with no "Use bundled" button', async () => {
      await openAdvanced({ engineSettings: { path: null } })

      expect(
        await screen.findByText('Bundled (b12078, Vulkan). Use your own build to try a newer llama.cpp.')
      ).toBeInTheDocument()
      expect(screen.getByText('Using the bundled build')).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Browse for llama-server.exe' })).toHaveTextContent(
        'Use my own…'
      )
      expect(screen.queryByRole('button', { name: 'Use bundled' })).not.toBeInTheDocument()
    })

    it('leaves the tag out of the bundled label when core has none', async () => {
      const { store } = await openAdvanced(
        { engineSettings: { path: null } },
        { coreState: ready, engines: { tag: null } }
      )

      // "Bundled (Vulkan)" is also what shows before core answers, so wait for the answer first.
      await waitFor(() =>
        expect(coreApi.endpoints.getEngines.select()(store.getState()).data?.bundled.tag).toBeNull()
      )
      expect(
        screen.getByText('Bundled (Vulkan). Use your own build to try a newer llama.cpp.')
      ).toBeInTheDocument()
    })

    it('"Use bundled" asks core to forget the custom path, and shows the bundled build again', async () => {
      const { coreHttp } = await openAdvanced(
        { engineSettings: { path: 'C:\\llama\\llama-server.exe' } },
        { coreState: ready }
      )

      fireEvent.click(await screen.findByRole('button', { name: 'Use bundled' }))

      expect(await screen.findByText('Using the bundled build')).toBeInTheDocument()
      expect(enginePutValues(coreHttp)).toEqual([{ ...defaultEngineSettings, path: null }])
      expect(putValues(coreHttp)).toEqual([])
      expect(screen.queryByRole('button', { name: 'Use bundled' })).not.toBeInTheDocument()
    })

    it("shows core's message when it refuses a change", async () => {
      const { coreHttp } = await openAdvanced(
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
      const { coreHttp, pick } = await openAdvanced({}, { coreState: ready })
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
      const { pick } = await openAdvanced({}, { coreState: ready })
      pick.mockResolvedValueOnce(true)

      fireEvent.click(screen.getByRole('button', { name: 'Browse for Models folder' }))

      await waitFor(() => expect(pick).toHaveBeenCalledWith('modelsDir'))
      expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    })

    it('changes nothing when the dialog is cancelled, and says so when saving fails', async () => {
      const { pick } = await openAdvanced({}, { coreState: { status: 'starting' } })

      fireEvent.click(screen.getByRole('button', { name: 'Browse for llama-server.exe' }))
      await waitFor(() => expect(pick).toHaveBeenCalledWith('llamaServer'))
      expect(screen.getByText(/OpenVatra.Models folder/)).toBeInTheDocument()

      pick.mockRejectedValueOnce(new Error('disk full'))
      fireEvent.click(screen.getByRole('button', { name: 'Browse for llama-server.exe' }))
      expect(await screen.findByRole('alert')).toHaveTextContent('That path could not be saved.')
    })
  })

  describe('the tabs and Advanced', () => {
    it('shows Installed with the count and Get more models, and ArrowRight opens the catalog', async () => {
      await openModels(
        { showAdvanced: false },
        { coreState: ready, models: [qwen, nomic], setup: { catalog } }
      )
      const installed = await screen.findByRole('tab', { name: 'Installed 2' })
      expect(installed).toHaveAttribute('aria-selected', 'true')
      expect(screen.getByRole('tablist', { name: 'Models' })).toBeInTheDocument()
      expect(screen.getByRole('list', { name: 'Installed models' })).toBeInTheDocument()

      installed.focus()
      fireEvent.keyDown(installed, { key: 'ArrowRight' })

      const more = screen.getByRole('tab', { name: 'Get more models' })
      expect(more).toHaveAttribute('aria-selected', 'true')
      expect(more).toHaveFocus()
      expect(await screen.findByText('Big 9B')).toBeInTheDocument()
      expect(screen.queryByRole('list', { name: 'Installed models' })).not.toBeInTheDocument()
    })

    it('keeps Advanced shut by default, opens it on click, and saves that', async () => {
      const { saveSettings } = await openModels(
        { showAdvanced: false },
        { coreState: ready, models: [qwen, nomic] }
      )
      const advanced = screen.getByRole('button', { name: 'Advanced' })
      expect(advanced).toHaveAttribute('aria-expanded', 'false')
      expect(screen.queryByRole('button', { name: 'Browse for llama-server.exe' })).not.toBeInTheDocument()
      expect(screen.queryByRole('button', { name: 'Restart' })).not.toBeInTheDocument()

      fireEvent.click(advanced)

      await waitFor(() => expect(saveSettings).toHaveBeenCalledWith({ showAdvancedModels: true }))
      expect(advanced).toHaveAttribute('aria-expanded', 'true')
      expect(screen.getByRole('button', { name: 'Browse for llama-server.exe' })).toBeInTheDocument()
      expect(await screen.findByRole('combobox', { name: 'Embedding model' })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Open log' })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Restart' })).toBeInTheDocument()
    })

    it('has no "Show advanced" switch and no "Get more models…" button', async () => {
      await openModels({ showAdvanced: false }, { coreState: ready, models: [qwen] })

      expect(screen.queryByRole('switch', { name: 'Show advanced' })).not.toBeInTheDocument()
      expect(screen.queryByRole('button', { name: 'Get more models…' })).not.toBeInTheDocument()
    })
  })

  it('puts the GPU card first, then the folder, the unload timer and the tabs', async () => {
    await openModels(chosen, { coreState: ready })
    const gpu = screen.getByRole('group', { name: 'Graphics card' })
    const folder = screen.getByText('Models folder')
    const unload = screen.getByRole('radiogroup', { name: 'Unload models after' })
    const tabs = screen.getByRole('tablist', { name: 'Models' })
    const before = (a: Element, b: Element): boolean =>
      Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING)

    expect(before(gpu, folder)).toBe(true)
    expect(before(folder, unload)).toBe(true)
    expect(before(unload, tabs)).toBe(true)
  })

  it('saves "Unload models after" in core, with Never as null', async () => {
    const { coreHttp } = await openAdvanced(chosen, { coreState: ready })
    const group = screen.getByRole('radiogroup', { name: 'Unload models after' })
    expect(within(group).getByRole('radio', { name: '15 min' })).toBeChecked()

    fireEvent.click(within(group).getByRole('radio', { name: '1 hour' }))
    await waitFor(() => expect(within(group).getByRole('radio', { name: '1 hour' })).toBeChecked())
    fireEvent.click(within(group).getByRole('radio', { name: 'Never' }))

    await waitFor(() => expect(within(group).getByRole('radio', { name: '1 hour' })).toBeChecked())
    expect(putValues(coreHttp).map((value) => value.idleUnloadMinutes)).toEqual([60, null])
    expect(enginePutValues(coreHttp)).toEqual([])
  })

  describe('empty and problem states', () => {
    it('restarts the service and opens the log', async () => {
      const { core, section } = await openAdvanced()

      fireEvent.click(within(section).getByRole('button', { name: 'Restart' }))
      fireEvent.click(within(section).getByRole('button', { name: 'Open log' }))

      expect(core.restart).toHaveBeenCalledOnce()
      expect(core.openLog).toHaveBeenCalledOnce()
    })
  })

  describe('the embedding model', () => {
    it('offers only embedding models, Automatic first, and saves the choice', async () => {
      const second: ModelInfo = { ...nomic, id: 'qwen3-embedding' }
      const { coreHttp } = await openAdvanced(chosen, { coreState: ready, models: [qwen, nomic, second] })
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
      await openAdvanced(chosen, { coreState: ready, models: [qwen] })
      const select = await screen.findByRole('combobox', { name: 'Embedding model' })

      expect(select).toBeDisabled()
      expect(select).toHaveDisplayValue('Not found')
    })

    it('warns about a chat model chosen for embeddings and resets it', async () => {
      const { coreHttp } = await openAdvanced(
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
      await openAdvanced({ ...chosen, embeddingModel: 'deleted' }, { coreState: ready, models: [nomic] })

      expect(await screen.findByRole('alert')).toHaveTextContent("deleted isn't an available embedding model")
    })
  })
})

describe('opening before core answered', () => {
  it('shows no values until core answered, then the saved ones at once', async () => {
    let release = (): void => {}
    const opened = new Promise<void>((resolve) => {
      release = resolve
    })
    const rendered = renderWithStore(
      <Shell />,
      {},
      // Core connects only after the fetch is held: until then nothing is asked.
      { coreState: { status: 'starting' }, llamacppSettings: { idleUnloadMinutes: 60 } }
    )
    const original = rendered.coreHttp.fetch
    vi.stubGlobal('fetch', (async (input, init) => {
      const url = input instanceof Request ? input.url : String(input)
      if (new URL(url).pathname === '/api/config/provider.llamacpp') await opened
      return original(input, init)
    }) as typeof fetch)
    act(() => {
      rendered.store.dispatch(settingsOpened({ section: 'models' }))
    })
    await screen.findByRole('dialog', { name: 'Settings' })
    rendered.core.emitState(ready)
    await waitFor(() => expect(screen.queryByText('Starting the models service…')).not.toBeInTheDocument())

    expect(screen.queryByRole('radiogroup', { name: 'Unload models after' })).not.toBeInTheDocument()
    release()

    const idle = await screen.findByRole('radiogroup', { name: 'Unload models after' })
    expect(within(idle).getByRole('radio', { name: '1 hour' })).toBeChecked()
  })
})
