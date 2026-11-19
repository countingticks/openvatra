import { useState } from 'react'
import { fireEvent, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import {
  defaultEngineSettings,
  defaultLlamacppSettings,
  type EngineChange,
  type LlamacppChange
} from '@app/features/models/modelSettings'
import { useEngineSettings } from '@app/features/models/useEngineSettings'
import { useLlamacppSettings } from '@app/features/models/useLlamacppSettings'
import { coreWrites, type CoreRequest } from '../../../fakeCoreHttp'
import { exampleConnection, renderWithStore } from '../../../renderWithStore'

const ready = { status: 'ready', port: 53121, version: '1', connection: exampleConnection } as const
const enginePath = '/api/config/engine.llamaserver'
const providerPath = '/api/config/provider.llamacpp'

/** Shows both sections and offers a few changes; a failed change shows its message. */
function Probe(): React.JSX.Element {
  const engine = useEngineSettings()
  const llamacpp = useLlamacppSettings()
  const [failure, setFailure] = useState<string>()
  const run = (update: () => Promise<void>): void => {
    setFailure(undefined)
    update().catch((error: Error) => setFailure(error.message))
  }
  const changeEngine = (change: EngineChange): void => run(() => engine.update(change))
  const changeLlamacpp = (change: LlamacppChange): void => run(() => llamacpp.update(change))
  return (
    <div>
      <p>Unload after {String(llamacpp.value.idleUnloadMinutes)}</p>
      <p>Engine {engine.value.build}</p>
      <p>Engine effective {engine.effective ? engine.effective.path : 'unknown'}</p>
      <p>Models effective {llamacpp.effective ? llamacpp.effective.modelsDir : 'unknown'}</p>
      <button onClick={() => changeLlamacpp({ idleUnloadMinutes: 60 })}>One hour</button>
      <button onClick={() => changeLlamacpp({ idleUnloadMinutes: 5 })}>Five minutes</button>
      <button onClick={() => changeEngine({ build: 'cuda' })}>CUDA</button>
      {failure && <p role="alert">{failure}</p>}
    </div>
  )
}

function show(options: Parameters<typeof renderWithStore>[2] = {}): ReturnType<typeof renderWithStore> {
  return renderWithStore(
    <Probe />,
    {},
    { coreState: ready, llamacppSettings: { idleUnloadMinutes: 30 }, ...options }
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

describe('section settings hooks', () => {
  it("show each section's defaults and no effective values until core answers", async () => {
    show()

    expect(screen.getByText('Unload after 15')).toBeInTheDocument()
    expect(screen.getByText('Engine bundled')).toBeInTheDocument()
    expect(screen.getByText('Engine effective unknown')).toBeInTheDocument()
    expect(screen.getByText('Models effective unknown')).toBeInTheDocument()
    expect(await screen.findByText('Unload after 30')).toBeInTheDocument()
    expect(await screen.findByText(/^Models effective C:/)).toBeInTheDocument()
  })

  it('useEngineSettings().update PUTs only the engine section, with the cached rev', async () => {
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

  it('useLlamacppSettings().update PUTs only the provider section, with the cached rev', async () => {
    const { coreHttp } = show()
    await screen.findByText('Unload after 30')

    fireEvent.click(screen.getByRole('button', { name: 'One hour' }))

    expect(await screen.findByText('Unload after 60')).toBeInTheDocument()
    expect(coreWrites(coreHttp)).toEqual([
      { method: 'PUT', path: providerPath, body: { rev: 1, value: provider(60) } }
    ])
  })

  it('PUTs two quick updates to one section one after the other, the second with the rev the first got back', async () => {
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

  it('on a conflict, applies the change on top of what core has now, once', async () => {
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

  it("rejects after a second conflict, with the newest value cached and core's message", async () => {
    const { coreHttp } = show()
    await screen.findByText('Unload after 30')
    let rev = 7
    coreHttp.respond('PUT', providerPath, () => conflict(rev++, 120))

    fireEvent.click(screen.getByRole('button', { name: 'One hour' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('the section changed since it was read')
    expect(screen.getByText('Unload after 120')).toBeInTheDocument()
    expect(puts(coreHttp.requests)).toHaveLength(2)
  })

  it("rejects with core's sentence when core refuses, keeps the value, and lets the next update run", async () => {
    const { coreHttp } = show()
    await screen.findByText('Unload after 30')
    let calls = 0
    coreHttp.respond('PUT', providerPath, (request) => {
      calls++
      if (calls === 1) {
        return {
          status: 400,
          body: { error: 'invalid_config', message: 'idleUnloadMinutes must be positive' }
        }
      }
      return { body: { rev: 2, value: (request.body as { value: unknown }).value } }
    })

    fireEvent.click(screen.getByRole('button', { name: 'One hour' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('idleUnloadMinutes must be positive')
    expect(screen.getByText('Unload after 30')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Five minutes' }))

    expect(await screen.findByText('Unload after 5')).toBeInTheDocument()
    expect(puts(coreHttp.requests)).toEqual([
      { rev: 1, value: provider(60) },
      { rev: 1, value: provider(5) }
    ])
  })
})
