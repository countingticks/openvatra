import { useState } from 'react'
import { act, fireEvent, screen, waitFor } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import {
  defaultEngineSettings,
  defaultLlamacppSettings,
  type ModelsChange
} from '@renderer/core/modelSettings'
import { useModelSettings } from '@renderer/hooks/useModelSettings'
import { coreWrites, type CoreRequest } from './fakeCoreHttp'
import { exampleConnection, renderWithStore } from './renderWithStore'

const ready = { status: 'ready', port: 53121, version: '1', connection: exampleConnection } as const
const enginePath = '/api/config/engine.llamaserver'
const providerPath = '/api/config/provider.llamacpp'

/** Shows what core has and offers a few changes; a failed change shows its message. */
function Probe(): React.JSX.Element {
  const { value, effective, update } = useModelSettings()
  const [failure, setFailure] = useState<string>()
  const change = (next: ModelsChange): void => {
    setFailure(undefined)
    update(next).catch((error: Error) => setFailure(error.message))
  }
  return (
    <div>
      <p>Unload after {String(value.idleUnloadMinutes)}</p>
      <p>Engine {value.engine}</p>
      <p>Effective {effective ? `${effective.llamaServerPath} | ${effective.modelsDir}` : 'unknown'}</p>
      <button onClick={() => change({ idleUnloadMinutes: 60 })}>One hour</button>
      <button onClick={() => change({ idleUnloadMinutes: 5 })}>Five minutes</button>
      <button onClick={() => change({ engine: 'cuda' })}>CUDA</button>
      {failure && <p role="alert">{failure}</p>}
    </div>
  )
}

function show(options: Parameters<typeof renderWithStore>[2] = {}): ReturnType<typeof renderWithStore> {
  return renderWithStore(
    <Probe />,
    {},
    { coreState: ready, modelSettings: { idleUnloadMinutes: 30 }, ...options }
  )
}

const puts = (requests: CoreRequest[], path = providerPath): unknown[] =>
  requests
    .filter((request) => request.method === 'PUT' && new URL(request.url).pathname === path)
    .map((request) => request.body)

const provider = (idleUnloadMinutes: number | null, embeddingModel: string | null = null): unknown => ({
  ...defaultLlamacppSettings,
  idleUnloadMinutes,
  embeddingModel
})

/** core's 409 answer, with the provider entry it has now. */
const conflict = (
  rev: number,
  idleUnloadMinutes: number,
  embeddingModel: string | null = null
): { status: number; body: unknown } => ({
  status: 409,
  body: {
    error: 'config_conflict',
    message: 'the section changed since it was read',
    current: { rev, value: provider(idleUnloadMinutes, embeddingModel) }
  }
})

const configChanged = (section: string, rev: number): { data: unknown } => ({
  data: { seq: 1, time: 1, stream: 'system', type: 'config.changed', v: 1, data: { section, rev } }
})

describe('useModelSettings', () => {
  it("shows core's defaults until core answers, then core's value", async () => {
    show()

    expect(screen.getByText('Unload after 15')).toBeInTheDocument()
    expect(await screen.findByText('Unload after 30')).toBeInTheDocument()
  })

  it('a change to idleUnloadMinutes PUTs only the provider section, with the cached rev', async () => {
    const { coreHttp } = show()
    await screen.findByText('Unload after 30')

    fireEvent.click(screen.getByRole('button', { name: 'One hour' }))

    expect(await screen.findByText('Unload after 60')).toBeInTheDocument()
    expect(coreWrites(coreHttp)).toEqual([
      { method: 'PUT', path: providerPath, body: { rev: 1, value: provider(60) } }
    ])
  })

  it('a change to engine PUTs only the engine section, with build', async () => {
    const { coreHttp } = show()
    await screen.findByText('Unload after 30')

    fireEvent.click(screen.getByRole('button', { name: 'CUDA' }))

    expect(await screen.findByText('Engine cuda')).toBeInTheDocument()
    expect(coreWrites(coreHttp)).toEqual([
      {
        method: 'PUT',
        path: enginePath,
        body: { rev: 1, value: { ...defaultEngineSettings, build: 'cuda' } }
      }
    ])
  })

  it('PUTs two quick changes to one section one after the other, the second with the rev the first got back', async () => {
    const { coreHttp } = show()
    await screen.findByText('Unload after 30')

    fireEvent.click(screen.getByRole('button', { name: 'One hour' }))
    fireEvent.click(screen.getByRole('button', { name: 'Five minutes' }))

    expect(await screen.findByText('Unload after 5')).toBeInTheDocument()
    expect(puts(coreHttp.requests)).toEqual([
      { rev: 1, value: provider(60) },
      { rev: 2, value: provider(5) }
    ])
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('on a conflict, applies the change on top of what core has now and PUTs that section again with its rev', async () => {
    const { coreHttp } = show()
    await screen.findByText('Unload after 30')
    let calls = 0
    coreHttp.respond('PUT', providerPath, (request) => {
      calls++
      if (calls === 1) return conflict(7, 30, 'nomic-embed')
      return { body: { rev: 8, value: (request.body as { value: unknown }).value } }
    })

    fireEvent.click(screen.getByRole('button', { name: 'One hour' }))

    expect(await screen.findByText('Unload after 60')).toBeInTheDocument()
    expect(puts(coreHttp.requests)).toEqual([
      { rev: 1, value: provider(60) },
      { rev: 7, value: provider(60, 'nomic-embed') }
    ])
    expect(puts(coreHttp.requests, enginePath)).toEqual([])
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it("shows the newest value and core's message after a second conflict", async () => {
    const { coreHttp } = show()
    await screen.findByText('Unload after 30')
    let rev = 7
    coreHttp.respond('PUT', providerPath, () => conflict(rev++, 120))

    fireEvent.click(screen.getByRole('button', { name: 'One hour' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('the section changed since it was read')
    expect(screen.getByText('Unload after 120')).toBeInTheDocument()
    expect(puts(coreHttp.requests)).toHaveLength(2)
  })

  it("keeps the shown value and gives core's message when core refuses the value", async () => {
    const { coreHttp } = show()
    await screen.findByText('Unload after 30')
    coreHttp.respond('PUT', providerPath, () => ({
      status: 400,
      body: { error: 'invalid_config', message: 'idleUnloadMinutes must be positive' }
    }))

    fireEvent.click(screen.getByRole('button', { name: 'One hour' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('idleUnloadMinutes must be positive')
    expect(screen.getByText('Unload after 30')).toBeInTheDocument()
  })

  it('says the service is not running when core is starting and nothing is cached', async () => {
    const { coreHttp } = show({ coreState: { status: 'starting' } })

    fireEvent.click(screen.getByRole('button', { name: 'One hour' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('The models service is not running')
    expect(coreHttp.requests).toEqual([])
  })

  it('has no effective paths until both sections answered', async () => {
    const { coreHttp } = show()
    // The engine section can't be read at first; the provider answers at once.
    coreHttp.respond('GET', enginePath, () => ({
      status: 503,
      body: { error: 'config_unavailable', message: 'config storage is not available' }
    }))
    await waitFor(() => expect(coreHttp.openStreams()).toBe(1))

    expect(await screen.findByText('Unload after 30')).toBeInTheDocument()
    expect(screen.getByText('Effective unknown')).toBeInTheDocument()

    coreHttp.respond('GET', enginePath, () => ({
      body: { rev: 1, value: defaultEngineSettings, effective: { path: 'C:\\llama-server.exe' } }
    }))
    act(() => {
      coreHttp.push(configChanged('engine.llamaserver', 1))
    })

    expect(
      await screen.findByText('Effective C:\\llama-server.exe | C:\\Users\\me\\OpenVatra\\Models')
    ).toBeInTheDocument()
  })

  it('reads the section again when another writer saved a newer rev', async () => {
    const { coreHttp } = show()
    await screen.findByText('Unload after 30')
    await waitFor(() => expect(coreHttp.openStreams()).toBe(1))

    coreHttp.setConfig('provider.llamacpp', { rev: 2, value: provider(45) })
    act(() => {
      coreHttp.push(configChanged('provider.llamacpp', 2))
    })

    expect(await screen.findByText('Unload after 45')).toBeInTheDocument()
  })
})
