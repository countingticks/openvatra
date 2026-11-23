import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { coreApi } from '@app/core/coreApi'
import type { LlamaServerSettings } from '@app/core/generated'
import { defaultEngineSettings, defaultLlamacppSettings } from '@app/features/models/modelSettings'
import type { ModelInfo } from '@app/core/types'
import { coreWrites, type FakeCoreHttp } from '../../../fakeCoreHttp'
import { chosen, nomic, openModels, putValues, qwen, ready } from '../models/openModelsSection'

// The GPU card asks for fresh hardware numbers whenever the section opens; that is not a write under test.
const HARDWARE = '/api/hardware/refresh'

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
      // In the dialog: the Chat tab's model button behind it names the model too.
      const dialog = screen.getByRole('dialog', { name: 'Settings' })
      expect(within(dialog).queryByText('Qwen3 8B')).not.toBeInTheDocument()
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
      const dialog = screen.getByRole('dialog', { name: 'Settings' })
      expect(await within(dialog).findByText('Qwen3 8B')).toBeInTheDocument()
    })

    it('removes a downloaded model only after confirming', async () => {
      const { coreHttp } = await openModels({ showAdvanced: false }, { coreState: ready, setup: { catalog } })

      fireEvent.click(await screen.findByRole('button', { name: 'Remove Small 3B' }))
      expect(coreWrites(coreHttp).filter((write) => write.path !== HARDWARE)).toEqual([])
      fireEvent.click(screen.getByRole('button', { name: 'Remove it' }))

      await waitFor(() =>
        expect(coreWrites(coreHttp).filter((write) => write.path !== HARDWARE)).toEqual([
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
    it('restarts the service and opens the log', async () => {
      const { core, section } = await openModels()

      fireEvent.click(within(section).getByRole('button', { name: 'Restart' }))
      fireEvent.click(within(section).getByRole('button', { name: 'Open log' }))

      expect(core.restart).toHaveBeenCalledOnce()
      expect(core.openLog).toHaveBeenCalledOnce()
    })
  })

  describe('the embedding model', () => {
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
})
