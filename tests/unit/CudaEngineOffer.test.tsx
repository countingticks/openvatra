import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { App } from '@renderer/App'
import { settingsOpened } from '@renderer/store/uiSlice'
import { defaultSettings, type ModelsSettings } from '../../src/shared/settings'
import type { ModelInfo } from '../../src/shared/core'
import { coreWrites } from './fakeCoreHttp'
import { exampleConnection, renderWithStore } from './renderWithStore'

const ready = { status: 'ready', port: 1234, version: '1', connection: exampleConnection } as const
const stopped: ModelInfo = { id: 'Qwen3-8B', state: 'stopped', busy: false, sizeBytes: 1, kind: 'chat' }
const broken: ModelInfo = { ...stopped, state: 'error', error: 'The model did not start.' }

function show(
  cuda: 'none' | 'ready' | 'stale',
  models: Partial<ModelsSettings> = {},
  list: ModelInfo[] = [stopped]
): ReturnType<typeof renderWithStore> {
  return renderWithStore(
    <App />,
    { models: { ...defaultSettings.models, ...models } },
    { coreState: ready, cuda, engines: { cuda }, models: list }
  )
}

const openPopover = async (): Promise<void> => {
  fireEvent.click(await screen.findByRole('button', { name: /^Model:/ }))
}

describe('faster engine for NVIDIA', () => {
  it('offers the download, and "Not now" hides the card for good', async () => {
    const { coreHttp, store } = show('none')
    await openPopover()

    await screen.findByRole('region', { name: 'Faster engine for your NVIDIA card' })
    fireEvent.click(screen.getByRole('button', { name: 'Download' }))
    await waitFor(() =>
      expect(coreWrites(coreHttp)).toEqual([
        { method: 'POST', path: '/api/downloads', body: { engine: 'cuda' } }
      ])
    )

    fireEvent.click(screen.getByRole('button', { name: 'Not now' }))
    expect(store.getState().settings.models.cudaOfferDismissed).toBe(true)
    expect(screen.queryByRole('region', { name: 'Faster engine for your NVIDIA card' })).toBeNull()
  })

  it("shows core's reason when the engine download fails", async () => {
    const { coreHttp } = show('none')
    coreHttp.respond('POST', '/api/downloads', () => ({
      status: 409,
      body: { error: 'not_enough_space', message: 'Not enough free space for the engine.' }
    }))
    await openPopover()

    const card = await screen.findByRole('region', { name: 'Faster engine for your NVIDIA card' })
    fireEvent.click(screen.getByRole('button', { name: 'Download' }))

    expect(await within(card).findByRole('alert')).toHaveTextContent('Not enough free space for the engine.')
  })

  it('offers "Use the faster engine" when core reports it installed', async () => {
    const { store } = renderWithStore(
      <App />,
      { models: { ...defaultSettings.models, cudaOfferDismissed: true } },
      { coreState: ready, engines: { cuda: 'ready' }, models: [stopped] }
    )
    act(() => {
      store.dispatch(settingsOpened('models'))
    })
    expect(await screen.findByRole('button', { name: 'Use the faster engine' })).toBeInTheDocument()
  })

  it('asks core about the engines again when the CUDA download finishes', async () => {
    const { coreHttp, setup } = show('none', {}, [stopped])
    const engineReads = (): number =>
      coreHttp.requests.filter((request) => request.url.endsWith('/api/engines')).length
    await openPopover()
    await screen.findByRole('region', { name: 'Faster engine for your NVIDIA card' })
    const before = engineReads()

    setup.emitDownloads([{ id: 'engine-cuda', state: 'downloading', bytes: 1, total: 2, speed: 1 }])
    setup.emitDownloads([{ id: 'engine-cuda', state: 'done', bytes: 2, total: 2, speed: 0 }])

    await waitFor(() => expect(engineReads()).toBe(before + 1))
  })

  it('offers the update when only an older build is installed', async () => {
    show('stale')
    await openPopover()
    expect(await screen.findByRole('region', { name: 'Update the faster engine' })).toBeInTheDocument()
  })

  it('stays out of the way with a custom llama-server, and once dismissed', async () => {
    show('none', { llamaServerPath: 'C:\\llama\\llama-server.exe', cudaOfferDismissed: true })
    await openPopover()
    await screen.findByRole('button', { name: 'Restart' })
    expect(screen.queryByText(/faster engine/i)).toBeNull()
  })

  it('lets Settings switch between the engines, whatever was dismissed', async () => {
    const { store } = show('ready', { engine: 'cuda', cudaOfferDismissed: true })
    act(() => {
      store.dispatch(settingsOpened('models'))
    })
    expect(await screen.findByText('In use. Models run faster on your graphics card.')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Use the standard engine' }))
    expect(store.getState().settings.models.engine).toBe('bundled')
    fireEvent.click(await screen.findByRole('button', { name: 'Use the faster engine' }))
    expect(store.getState().settings.models.engine).toBe('cuda')
  })

  it('the Settings line follows main when the CUDA download switches the engine', async () => {
    const { store, emitSettings } = show('ready', { engine: 'bundled', showAdvanced: true })
    act(() => {
      store.dispatch(settingsOpened('models'))
    })
    expect(await screen.findByRole('button', { name: 'Use the faster engine' })).toBeInTheDocument()

    const settings = store.getState().settings
    emitSettings({ ...settings, models: { ...settings.models, engine: 'cuda' } })

    expect(await screen.findByRole('button', { name: 'Use the standard engine' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Use the faster engine' })).toBeNull()
  })

  it('offers "Use the standard engine" next to a model that failed to start, while CUDA is in use', async () => {
    const { store } = show('ready', { engine: 'cuda' }, [broken])
    await openPopover()
    expect(await screen.findByText('The model did not start.')).toBeInTheDocument()
    fireEvent.click(await screen.findByRole('button', { name: 'Use the standard engine' }))
    expect(store.getState().settings.models.engine).toBe('bundled')
  })

  it('does not blame the engine when CUDA is not in use', async () => {
    show('none', { cudaOfferDismissed: true }, [broken])
    await openPopover()
    expect(await screen.findByText('The model did not start.')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Use the standard engine' })).toBeNull()
  })
})
