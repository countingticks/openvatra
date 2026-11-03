import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { App } from '@renderer/App'
import { settingsOpened } from '@renderer/store/uiSlice'
import type { CoreState, ModelInfo } from '../../../src/shared/core'
import { defaultSettings, type ModelsSettings, type Settings } from '../../../src/shared/settings'
import { renderWithStore } from '../renderWithStore'

const ready: CoreState = { status: 'ready', port: 1234, version: '1' }
const chosen: ModelsSettings = {
  ...defaultSettings.models,
  llamaServerPath: 'C:\\llama\\llama-server.exe',
  modelsDir: 'D:\\models'
}
const qwen: ModelInfo = { id: 'Qwen3-8B-Q4_K_M', state: 'stopped', busy: false, sizeBytes: 5 * 1024 ** 3 }
const nomic: ModelInfo = { id: 'nomic-embed', state: 'ready', busy: false, sizeBytes: 140 * 1024 ** 2 }

type Rendered = ReturnType<typeof renderWithStore>

/** Renders the app with Settings open on Models. */
async function openModels(
  models: Partial<ModelsSettings> = chosen,
  options: { coreState?: CoreState; models?: ModelInfo[] } = {}
): Promise<Rendered & { section: HTMLElement }> {
  const rendered = renderWithStore(<App />, { models: { ...defaultSettings.models, ...models } }, options)
  act(() => {
    rendered.store.dispatch(settingsOpened('models'))
  })
  const section = await screen.findByRole('region', { name: 'Available models' })
  return { ...rendered, section }
}

describe('Settings → Models', () => {
  describe('paths', () => {
    it('shows both paths, or "Not chosen", and explains what to choose first', async () => {
      await openModels({ llamaServerPath: 'C:\\llama\\llama-server.exe' })

      expect(screen.getByText('C:\\llama\\llama-server.exe')).toBeInTheDocument()
      expect(screen.getByText('Not chosen')).toBeInTheDocument()
      expect(screen.getByRole('status')).toHaveTextContent('Choose llama-server.exe and your models folder')
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
      const { pick } = await openModels({})

      fireEvent.click(screen.getByRole('button', { name: 'Browse for llama-server.exe' }))
      await waitFor(() => expect(pick).toHaveBeenCalledWith('llamaServer'))
      expect(screen.getAllByText('Not chosen')).toHaveLength(2)

      pick.mockRejectedValueOnce(new Error('disk full'))
      fireEvent.click(screen.getByRole('button', { name: 'Browse for llama-server.exe' }))
      expect(await screen.findByRole('alert')).toHaveTextContent('That path could not be saved.')
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
      await openModels()
      expect(screen.getByRole('status')).toHaveTextContent('Starting the models service…')
    })

    it('shows the service problem first, even before the paths are chosen', async () => {
      await openModels({}, { coreState: { status: 'problem', reason: 'core exited (code 1)' } })
      expect(await screen.findByRole('alert')).toHaveTextContent(
        'The models service has a problem: core exited (code 1)'
      )
    })

    it('says when the folder has no models', async () => {
      await openModels(chosen, { coreState: ready })
      expect(await screen.findByRole('status')).toHaveTextContent('No models found')
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
    it('lists each model with its size, and follows changes, with no state and no Load or Unload', async () => {
      const { core } = await openModels(chosen, { coreState: ready, models: [qwen, nomic] })

      const list = await screen.findByRole('list', { name: 'Available models' })
      expect(within(list).getByText('5.0 GB')).toBeInTheDocument()
      expect(within(list).getByText('140 MB')).toBeInTheDocument()
      expect(within(list).queryByText(/Loaded|Not loaded/)).not.toBeInTheDocument()
      expect(screen.queryByRole('button', { name: /^(Load|Unload) / })).not.toBeInTheDocument()

      core.emitModels([qwen])

      expect(screen.queryByText(/nomic-embed/)).not.toBeInTheDocument()
    })

    it('chooses the embedding model, or none', async () => {
      const { saveSettings } = await openModels(
        { ...chosen, embeddingModel: 'nomic-embed' },
        { coreState: ready, models: [qwen, nomic] }
      )
      const select = await screen.findByRole('combobox', { name: 'Embedding model' })
      expect(select).toHaveValue('nomic-embed')
      expect(
        within(select)
          .getAllByRole('option')
          .map((option) => option.textContent)
      ).toEqual(['None', qwen.id, 'nomic-embed'])

      fireEvent.change(select, { target: { value: qwen.id } })
      await waitFor(() =>
        expect(saveSettings).toHaveBeenLastCalledWith({ models: { embeddingModel: qwen.id } })
      )
      expect(select).toHaveValue(qwen.id)

      fireEvent.change(select, { target: { value: '' } })
      await waitFor(() => expect(saveSettings).toHaveBeenLastCalledWith({ models: { embeddingModel: null } }))
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

    it('shows the detected projector read-only, with no switch', async () => {
      await openModels(
        { ...chosen, options: {} },
        { coreState: ready, models: [{ ...qwen, projector: 'mmproj-qwen.gguf' }, nomic] }
      )
      fireEvent.click(await screen.findByRole('button', { name: `Options for ${qwen.id}` }))
      const group = screen.getByRole('group', { name: `Options for ${qwen.id}` })

      expect(within(group).getByText(/mmproj-qwen\.gguf/)).toBeInTheDocument()
      expect(within(group).queryByRole('switch')).not.toBeInTheDocument()
    })

    it('says so when no projector was found, and has no per-model unload setting', async () => {
      const { group } = await openOptions()

      expect(within(group).getByText('No projector found next to this model.')).toBeInTheDocument()
      expect(within(group).queryByRole('radiogroup')).not.toBeInTheDocument()
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
