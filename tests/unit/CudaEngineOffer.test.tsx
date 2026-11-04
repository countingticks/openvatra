import { act, fireEvent, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { App } from '@renderer/App'
import { settingsOpened } from '@renderer/store/uiSlice'
import { defaultSettings, type ModelsSettings } from '../../src/shared/settings'
import type { ModelInfo } from '../../src/shared/core'
import { renderWithStore } from './renderWithStore'

const ready = { status: 'ready', port: 1234, version: '1' } as const
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
    { coreState: ready, cuda, models: list }
  )
}

const openPopover = async (): Promise<void> => {
  fireEvent.click(await screen.findByRole('button', { name: /^Model:/ }))
}

describe('faster engine for NVIDIA', () => {
  it('offers the download, and "Not now" hides the card for good', async () => {
    const { setup, store } = show('none')
    await openPopover()

    await screen.findByRole('region', { name: 'Faster engine for your NVIDIA card' })
    fireEvent.click(screen.getByRole('button', { name: 'Download' }))
    expect(setup.downloadEngine).toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Not now' }))
    expect(store.getState().settings.models.cudaOfferDismissed).toBe(true)
    expect(screen.queryByRole('region', { name: 'Faster engine for your NVIDIA card' })).toBeNull()
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
