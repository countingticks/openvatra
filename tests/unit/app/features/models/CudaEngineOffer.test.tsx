import { act, fireEvent, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { Shell } from '@app/shell/Shell'
import type { LlamaServerSettings } from '@app/core/generated'
import { settingsOpened } from '@app/store/uiSlice'
import type { ModelInfo } from '@app/core/types'
import { coreWrites, type FakeCoreHttp } from '../../../fakeCoreHttp'
import { exampleConnection, renderWithStore } from '../../../renderWithStore'

const ready = { status: 'ready', port: 1234, version: '1', connection: exampleConnection } as const
const stopped: ModelInfo = {
  id: 'Qwen3-8B',
  state: 'stopped',
  busy: false,
  sizeBytes: 1,
  kind: 'chat',
  context: null,
  moe: false,
  name: 'Qwen3-8B',
  quant: null,
  tags: []
}

/** The two window flags that sit beside core's engine section in a test's arguments. */
interface Preferences {
  engineSettings?: Partial<LlamaServerSettings>
  showAdvanced?: boolean
  cudaOfferDismissed?: boolean
}

/** The window's preferences go to the saved settings, the rest is core's models section. */
function show(
  cuda: 'none' | 'ready' | 'stale',
  models: Preferences = {},
  list: ModelInfo[] = [stopped]
): ReturnType<typeof renderWithStore> {
  const { showAdvanced, cudaOfferDismissed, engineSettings } = models
  return renderWithStore(
    <Shell />,
    { showAdvancedModels: showAdvanced ?? false, cudaOfferDismissed: cudaOfferDismissed ?? false },
    { coreState: ready, engines: { cuda }, models: list, engineSettings }
  )
}

/** The build each PUT of the engine section asked for, in order. */
const enginesPut = (http: FakeCoreHttp): LlamaServerSettings['build'][] =>
  coreWrites(http)
    .filter((write) => write.method === 'PUT' && write.path === '/api/config/engine.llamaserver')
    .map((write) => (write.body as { value: LlamaServerSettings }).value.build)

describe('faster engine for NVIDIA', () => {
  it('offers "Use the faster engine" when core reports it installed', async () => {
    const { store } = renderWithStore(
      <Shell />,
      { cudaOfferDismissed: true },
      {
        coreState: ready,
        engines: { cuda: 'ready' },
        models: [stopped],
        engineSettings: { build: 'bundled' }
      }
    )
    act(() => {
      store.dispatch(settingsOpened('models'))
    })
    expect(await screen.findByRole('button', { name: 'Use the faster engine' })).toBeInTheDocument()
  })

  it('lets Settings switch between the engines, whatever was dismissed', async () => {
    const { coreHttp, store } = show('ready', { engineSettings: { build: 'cuda' }, cudaOfferDismissed: true })
    act(() => {
      store.dispatch(settingsOpened('models'))
    })
    expect(await screen.findByText('In use. Models run faster on your graphics card.')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Use the standard engine' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Use the faster engine' }))

    expect(await screen.findByRole('button', { name: 'Use the standard engine' })).toBeInTheDocument()
    expect(enginesPut(coreHttp)).toEqual(['bundled', 'auto'])
  })

  it('accepting the offer writes build auto to the engine section and nothing to the provider section', async () => {
    const { coreHttp, store } = show('ready', { engineSettings: { build: 'bundled' }, showAdvanced: true })
    act(() => {
      store.dispatch(settingsOpened('models'))
    })

    fireEvent.click(await screen.findByRole('button', { name: 'Use the faster engine' }))

    expect(await screen.findByRole('button', { name: 'Use the standard engine' })).toBeInTheDocument()
    expect(coreWrites(coreHttp)).toEqual([
      {
        method: 'PUT',
        path: '/api/config/engine.llamaserver',
        body: { rev: 1, value: { path: null, build: 'auto' } }
      }
    ])
  })

  it('the Settings line follows core when the CUDA download finishes', async () => {
    const { coreHttp, setup, store } = show('none', { engineSettings: { build: 'auto' }, showAdvanced: true })
    act(() => {
      store.dispatch(settingsOpened('models'))
    })
    expect(await screen.findByRole('button', { name: 'Download' })).toBeInTheDocument()

    coreHttp.answer('/api/engines', { bundled: { tag: 'b12078' }, cuda: 'ready' })
    setup.emitDownloads([{ id: 'engine-cuda', state: 'downloading', bytes: 1, total: 2, speed: 1 }])
    setup.emitDownloads([{ id: 'engine-cuda', state: 'done', bytes: 2, total: 2, speed: 0 }])

    expect(await screen.findByText('In use. Models run faster on your graphics card.')).toBeInTheDocument()
    expect(enginesPut(coreHttp)).toEqual([])
  })

  it('a stored cuda with the build ready still shows "In use" and offers the standard engine', async () => {
    const { store } = show('ready', { engineSettings: { build: 'cuda' }, showAdvanced: true })
    act(() => {
      store.dispatch(settingsOpened('models'))
    })

    expect(await screen.findByText('In use. Models run faster on your graphics card.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Use the standard engine' })).toBeInTheDocument()
  })
})
