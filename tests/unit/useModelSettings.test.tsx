import { useState } from 'react'
import { act, fireEvent, screen, waitFor } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { defaultCoreModels, type ModelsChange } from '@renderer/core/modelSettings'
import { useModelSettings } from '@renderer/hooks/useModelSettings'
import { coreWrites, type CoreRequest } from './fakeCoreHttp'
import { exampleConnection, renderWithStore } from './renderWithStore'

const ready = { status: 'ready', port: 53121, version: '1', connection: exampleConnection } as const

/** Shows the unload timer core has and offers two changes; a failed change shows its message. */
function Probe(): React.JSX.Element {
  const { value, update } = useModelSettings()
  const [failure, setFailure] = useState<string>()
  const change = (next: ModelsChange): void => {
    setFailure(undefined)
    update(next).catch((error: Error) => setFailure(error.message))
  }
  return (
    <div>
      <p>Unload after {String(value.idleUnloadMinutes)}</p>
      <button onClick={() => change({ idleUnloadMinutes: 60 })}>One hour</button>
      <button onClick={() => change({ idleUnloadMinutes: 5 })}>Five minutes</button>
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

const puts = (requests: CoreRequest[]): unknown[] =>
  requests
    .filter((request) => request.method === 'PUT' && request.url.endsWith('/api/config/models'))
    .map((request) => request.body)

/** core's 409 answer, with the entry it has now. */
const conflict = (
  rev: number,
  idleUnloadMinutes: number,
  embeddingModel: string | null = null
): { status: number; body: unknown } => ({
  status: 409,
  body: {
    error: 'config_conflict',
    message: 'the section changed since it was read',
    current: { rev, value: { ...defaultCoreModels, idleUnloadMinutes, embeddingModel } }
  }
})

describe('useModelSettings', () => {
  it("shows core's defaults until core answers, then core's value", async () => {
    show()

    expect(screen.getByText('Unload after 15')).toBeInTheDocument()
    expect(await screen.findByText('Unload after 30')).toBeInTheDocument()
  })

  it("PUTs the cached rev with the merged value and shows core's answer", async () => {
    const { coreHttp } = show()
    await screen.findByText('Unload after 30')

    fireEvent.click(screen.getByRole('button', { name: 'One hour' }))

    expect(await screen.findByText('Unload after 60')).toBeInTheDocument()
    expect(coreWrites(coreHttp)).toEqual([
      {
        method: 'PUT',
        path: '/api/config/models',
        body: { rev: 1, value: { ...defaultCoreModels, idleUnloadMinutes: 60 } }
      }
    ])
  })

  it('PUTs two quick changes one after the other, the second with the rev the first got back', async () => {
    const { coreHttp } = show()
    await screen.findByText('Unload after 30')

    fireEvent.click(screen.getByRole('button', { name: 'One hour' }))
    fireEvent.click(screen.getByRole('button', { name: 'Five minutes' }))

    expect(await screen.findByText('Unload after 5')).toBeInTheDocument()
    expect(puts(coreHttp.requests)).toEqual([
      { rev: 1, value: { ...defaultCoreModels, idleUnloadMinutes: 60 } },
      { rev: 2, value: { ...defaultCoreModels, idleUnloadMinutes: 5 } }
    ])
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('on a conflict, applies the change on top of what core has now and PUTs again with its rev', async () => {
    const { coreHttp } = show()
    await screen.findByText('Unload after 30')
    let calls = 0
    coreHttp.respond('PUT', '/api/config/models', (request) => {
      calls++
      if (calls === 1) return conflict(7, 30, 'nomic-embed')
      return { body: { rev: 8, value: (request.body as { value: unknown }).value } }
    })

    fireEvent.click(screen.getByRole('button', { name: 'One hour' }))

    expect(await screen.findByText('Unload after 60')).toBeInTheDocument()
    expect(puts(coreHttp.requests)).toEqual([
      { rev: 1, value: { ...defaultCoreModels, idleUnloadMinutes: 60 } },
      { rev: 7, value: { ...defaultCoreModels, idleUnloadMinutes: 60, embeddingModel: 'nomic-embed' } }
    ])
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it("shows the newest value and core's message after a second conflict", async () => {
    const { coreHttp } = show()
    await screen.findByText('Unload after 30')
    let rev = 7
    coreHttp.respond('PUT', '/api/config/models', () => conflict(rev++, 120))

    fireEvent.click(screen.getByRole('button', { name: 'One hour' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('the section changed since it was read')
    expect(screen.getByText('Unload after 120')).toBeInTheDocument()
    expect(puts(coreHttp.requests)).toHaveLength(2)
  })

  it("keeps the shown value and gives core's message when core refuses the value", async () => {
    const { coreHttp } = show()
    await screen.findByText('Unload after 30')
    coreHttp.respond('PUT', '/api/config/models', () => ({
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

  it('reads the section again when another writer saved a newer rev', async () => {
    const { coreHttp } = show()
    await screen.findByText('Unload after 30')
    await waitFor(() => expect(coreHttp.openStreams()).toBe(1))

    coreHttp.setConfigModels({ rev: 2, value: { ...defaultCoreModels, idleUnloadMinutes: 45 } })
    act(() => {
      coreHttp.push({
        data: {
          seq: 1,
          time: 1,
          stream: 'system',
          type: 'config.changed',
          v: 1,
          data: { section: 'models', rev: 2 }
        }
      })
    })

    expect(await screen.findByText('Unload after 45')).toBeInTheDocument()
  })
})
