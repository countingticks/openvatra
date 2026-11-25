import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Shell } from '@app/shell/Shell'
import type { LlamaServerSettings } from '@app/core/generated'
import { settingsOpened } from '@app/store/uiSlice'
import type { DownloadItem, HardwareReport, ModelInfo } from '@app/core/types'
import { coreWrites, type FakeCoreHttp } from '../../../fakeCoreHttp'
import { exampleConnection, exampleHardware, renderWithStore } from '../../../renderWithStore'

const gib = 1024 ** 3
const ready = { status: 'ready', port: 1234, version: '1', connection: exampleConnection } as const

const model = (state: ModelInfo['state'], id = 'Qwen3-8B', vramGib: number | null = null): ModelInfo => ({
  id,
  state,
  busy: false,
  sizeBytes: 1,
  kind: 'chat',
  context: null,
  moe: false,
  name: id,
  quant: null,
  tags: [],
  memory: vramGib === null ? null : { vramBytes: vramGib * gib, ramBytes: 0 }
})

const download = (state: DownloadItem['state'], extra: Partial<DownloadItem> = {}): DownloadItem => ({
  id: 'engine-cuda',
  name: 'engine.zip',
  state,
  bytes: 0,
  total: 100,
  speed: 0,
  ...extra
})

interface Setup {
  cuda?: 'none' | 'ready' | 'stale'
  engineSettings?: Partial<LlamaServerSettings>
  hardware?: HardwareReport
  downloads?: DownloadItem[]
  models?: ModelInfo[]
}

/** Renders the app with Settings open on Models; every POST of the hardware refresh is answered. */
function show({ cuda, engineSettings, hardware, downloads, models }: Setup = {}): ReturnType<
  typeof renderWithStore
> {
  const rendered = renderWithStore(
    <Shell />,
    {},
    {
      coreState: ready,
      engines: { cuda: cuda ?? 'none' },
      engineSettings,
      models: models ?? [],
      setup: { hardware, downloads }
    }
  )
  rendered.coreHttp.answer('/api/hardware/refresh', hardware ?? exampleHardware, { method: 'POST' })
  act(() => {
    rendered.store.dispatch(settingsOpened({ section: 'models' }))
  })
  return rendered
}

const card = (): Promise<HTMLElement> => screen.findByRole('group', { name: 'Graphics card' })
const engine = (): HTMLElement => screen.getByRole('radiogroup', { name: 'Engine' })
const radio = (name: string): HTMLElement => within(engine()).getByRole('radio', { name })

const builds = (http: FakeCoreHttp): LlamaServerSettings['build'][] =>
  coreWrites(http)
    .filter((write) => write.method === 'PUT' && write.path === '/api/config/engine.llamaserver')
    .map((write) => (write.body as { value: LlamaServerSettings }).value.build)
const writes = (http: FakeCoreHttp, method: string, path: string): number =>
  coreWrites(http).filter((write) => write.method === method && write.path === path).length

afterEach(() => {
  vi.useRealTimers()
})

describe('GpuCard', () => {
  it('names the card and its memory, with the full sentence as its title', async () => {
    show()
    const group = await card()

    expect(within(group).getByText('NVIDIA GeForce RTX 4070')).toBeInTheDocument()
    expect(within(group).getByText('· 12.0 GB')).toBeInTheDocument()
    expect(within(group).getByTitle('NVIDIA GeForce RTX 4070, 12.0 GB of video memory')).toBeInTheDocument()
  })

  it('says so without a graphics card, and shows the RAM', async () => {
    show({ hardware: { gpu: null, ramBytes: 32 * gib } })
    const group = await card()

    expect(group).toHaveTextContent('No graphics card found. Models run on the CPU.')
    expect(group).toHaveTextContent('RAM · 32.0 GB')
    expect(screen.queryByRole('radiogroup', { name: 'Engine' })).not.toBeInTheDocument()
  })

  it('has no switch on an AMD card, and the note says Vulkan', async () => {
    const gpu = { ...exampleHardware.gpu!, name: 'AMD Radeon RX 7800 XT', vendor: 'amd' }
    show({ hardware: { ...exampleHardware, gpu } })
    const group = await card()

    expect(screen.queryByRole('radiogroup', { name: 'Engine' })).not.toBeInTheDocument()
    expect(within(group).getByText('Vulkan')).toBeInTheDocument()
  })

  it('has no switch with an engine of the user’s own', async () => {
    show({ engineSettings: { path: 'C:\\llama\\llama-server.exe' } })
    const group = await card()

    expect(screen.queryByRole('radiogroup', { name: 'Engine' })).not.toBeInTheDocument()
    expect(within(group).getByText('Your own llama-server.exe')).toBeInTheDocument()
  })

  it('shows Faster when CUDA is ready and the build is auto', async () => {
    show({ cuda: 'ready', engineSettings: { build: 'auto' } })
    const group = await card()

    await waitFor(() => expect(radio('Faster')).toBeChecked())
    expect(within(group).getByText('CUDA, for NVIDIA cards')).toBeInTheDocument()
  })

  it('shows Compatible by default, while CUDA is not installed', async () => {
    show()
    const group = await card()

    await waitFor(() => expect(radio('Compatible')).toBeChecked())
    expect(within(group).getByText('Vulkan, works on any card')).toBeInTheDocument()
  })

  it('shows Faster for a stored build cuda with CUDA ready', async () => {
    show({ cuda: 'ready', engineSettings: { build: 'cuda' } })
    await card()

    await waitFor(() => expect(radio('Faster')).toBeChecked())
  })

  it('picking Faster with CUDA missing starts the download and writes build auto', async () => {
    const { coreHttp } = show()
    await card()

    fireEvent.click(radio('Faster'))

    await waitFor(() => expect(builds(coreHttp)).toEqual(['auto']))
    expect(coreWrites(coreHttp).find((write) => write.path === '/api/downloads')).toEqual({
      method: 'POST',
      path: '/api/downloads',
      body: { engine: 'cuda' }
    })
  })

  it('shows the download’s progress and cancels it', async () => {
    const { coreHttp } = show({
      engineSettings: { build: 'auto' },
      downloads: [download('downloading', { bytes: 42 })]
    })
    const group = await card()

    expect(await within(group).findByText('Downloading the faster engine · 42%')).toBeInTheDocument()
    fireEvent.click(within(group).getByRole('button', { name: 'Cancel' }))

    await waitFor(() => expect(writes(coreHttp, 'DELETE', '/api/downloads/engine-cuda')).toBe(1))
  })

  it('shows a failed download’s error, with Compatible checked', async () => {
    show({
      engineSettings: { build: 'auto' },
      downloads: [download('error', { bytes: 10, error: 'The connection dropped.' })]
    })
    const group = await card()

    expect(await within(group).findByRole('alert')).toHaveTextContent('The connection dropped.')
    expect(radio('Compatible')).toBeChecked()
  })

  it('picking Faster with a failed download resumes it instead of starting another', async () => {
    const { coreHttp } = show({ downloads: [download('error', { error: 'x' })] })
    await card()

    fireEvent.click(radio('Faster'))

    await waitFor(() => expect(builds(coreHttp)).toEqual(['auto']))
    expect(writes(coreHttp, 'POST', '/api/downloads/engine-cuda/resume')).toBe(1)
    expect(writes(coreHttp, 'POST', '/api/downloads')).toBe(0)
  })

  it('picking Compatible writes build bundled and cancels a running download', async () => {
    const { coreHttp } = show({
      engineSettings: { build: 'auto' },
      downloads: [download('downloading', { bytes: 5 })]
    })
    await card()
    await waitFor(() => expect(radio('Faster')).toBeChecked())

    fireEvent.click(radio('Compatible'))

    await waitFor(() => expect(builds(coreHttp)).toEqual(['bundled']))
    await waitFor(() => expect(writes(coreHttp, 'DELETE', '/api/downloads/engine-cuda')).toBe(1))
  })

  it('picking Faster with CUDA ready and build bundled writes build auto and downloads nothing', async () => {
    const { coreHttp } = show({ cuda: 'ready', engineSettings: { build: 'bundled' } })
    await card()

    fireEvent.click(radio('Faster'))

    await waitFor(() => expect(builds(coreHttp)).toEqual(['auto']))
    expect(writes(coreHttp, 'POST', '/api/downloads')).toBe(0)
  })

  it('adds up what a ready model holds in the legend', async () => {
    show({ models: [model('ready', 'Qwen3-8B', 4)] })
    const group = await card()

    expect(await within(group).findByText('Model · 4.0 GB')).toBeInTheDocument()
    expect(within(group).getByRole('img')).toHaveAccessibleName(
      'Model 4.0 GB, other apps 0.0 GB, free 8.0 GB of 12.0 GB'
    )
  })

  it('shows why an engine write failed', async () => {
    const { coreHttp } = show({ cuda: 'ready', engineSettings: { build: 'bundled' } })
    coreHttp.answer(
      '/api/config/engine.llamaserver',
      { error: 'bad_request', message: 'The engine could not be saved.' },
      { method: 'PUT', status: 400 }
    )
    await card()

    fireEvent.click(radio('Faster'))

    expect(await screen.findByRole('alert')).toHaveTextContent('The engine could not be saved.')
  })
})

describe('the memory bar', () => {
  it('jumps while the first refresh is on its way and animates once it answered', async () => {
    let release = (): void => {}
    const opened = new Promise<void>((resolve) => {
      release = resolve
    })
    const rendered = renderWithStore(
      <Shell />,
      {},
      { coreState: ready, engines: { cuda: 'none' }, models: [] }
    )
    const original = rendered.coreHttp.fetch
    vi.stubGlobal('fetch', (async (input, init) => {
      const url = input instanceof Request ? input.url : String(input)
      if (new URL(url).pathname === '/api/hardware/refresh') await opened
      return original(input, init)
    }) as typeof fetch)
    rendered.coreHttp.answer('/api/hardware/refresh', exampleHardware, { method: 'POST' })
    act(() => {
      rendered.store.dispatch(settingsOpened({ section: 'models' }))
    })
    await card()
    const segments = (): Element[] => Array.from(screen.getByRole('img', { name: /^Model / }).children)

    expect(segments()).toHaveLength(2)
    segments().forEach((segment) => expect(segment).not.toHaveAttribute('data-slide'))
    // The stored numbers may be stale: hidden, their space kept, until the measurement answered.
    expect(screen.getByRole('img', { name: /^Model / })).toHaveClass('invisible')
    release()

    await waitFor(() => segments().forEach((segment) => expect(segment).toHaveAttribute('data-slide')))
    expect(screen.getByRole('img', { name: /^Model / })).not.toHaveClass('invisible')
  })
})

describe('useFreshHardware', () => {
  const refreshes = (http: FakeCoreHttp): number => writes(http, 'POST', '/api/hardware/refresh')

  it('asks for fresh numbers once when the section opens', async () => {
    const { coreHttp } = show()
    await card()

    await waitFor(() => expect(refreshes(coreHttp)).toBe(1))
  })

  it('refreshes 1 s after a model turns ready, not before', async () => {
    const { coreHttp, core } = show({ models: [model('stopped')] })
    await card()
    await waitFor(() => expect(refreshes(coreHttp)).toBe(1))
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
    await act(() => vi.advanceTimersByTimeAsync(5000))

    core.emitModels([model('ready')])
    await act(() => vi.advanceTimersByTimeAsync(900))
    expect(refreshes(coreHttp)).toBe(1)
    await act(() => vi.advanceTimersByTimeAsync(200))

    expect(refreshes(coreHttp)).toBe(2)
  })

  it('keeps refreshes 5 s apart when models change in quick succession', async () => {
    const { coreHttp, core } = show({ models: [model('stopped', 'a'), model('stopped', 'b')] })
    await card()
    await waitFor(() => expect(refreshes(coreHttp)).toBe(1))
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
    await act(() => vi.advanceTimersByTimeAsync(5000))

    core.emitModels([model('ready', 'a'), model('stopped', 'b')])
    await act(() => vi.advanceTimersByTimeAsync(1100))
    expect(refreshes(coreHttp)).toBe(2)
    core.emitModels([model('ready', 'a'), model('ready', 'b')])
    await act(() => vi.advanceTimersByTimeAsync(1000))
    expect(refreshes(coreHttp)).toBe(2)
    await act(() => vi.advanceTimersByTimeAsync(4500))

    expect(refreshes(coreHttp)).toBe(3)
  })
})
