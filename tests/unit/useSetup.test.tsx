import { act, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { useSetup } from '@renderer/hooks/useSetup'
import type { HardwareReport } from '@renderer/core/types'
import { exampleCatalogEntry, exampleConnection, exampleHardware, renderWithStore } from './renderWithStore'

const running = { id: 'qwen3-4b', state: 'downloading', bytes: 1, total: 10, speed: 1 } as const
const ready = { status: 'ready', port: 1234, version: '1', connection: exampleConnection } as const

function Probe(): React.JSX.Element {
  const { hardware, catalog, downloads, refreshCatalog } = useSetup()
  return (
    <div>
      <p>{hardware ? `ram ${hardware.ramBytes}` : 'no hardware'}</p>
      <p>
        {catalog ? catalog.entries.map((entry) => `${entry.id} ${entry.sizeBytes}`).join(', ') : 'no catalog'}
      </p>
      <p>{downloads.map((item) => `${item.id} ${item.state}`).join(', ') || 'empty'}</p>
      <button onClick={refreshCatalog}>Refresh</button>
    </div>
  )
}

const catalogRequests = (requests: { url: string }[]): number =>
  requests.filter((request) => request.url.endsWith('/api/catalog')).length

describe('useSetup', () => {
  it('reads hardware and the catalog from core; a catalog entry is as big as its files together', async () => {
    const entry = exampleCatalogEntry({
      files: [
        { name: 'a.gguf', sha256: 'a'.repeat(64), sizeBytes: 1000 },
        { name: 'b.gguf', sha256: 'b'.repeat(64), sizeBytes: 234 }
      ]
    })
    renderWithStore(
      <Probe />,
      {},
      { setup: { catalog: { entries: [entry], diskFreeBytes: 7, recommended: null } } }
    )

    expect(await screen.findByText(`ram ${exampleHardware.ramBytes}`)).toBeInTheDocument()
    expect(await screen.findByText('qwen3-4b 1234')).toBeInTheDocument()
  })

  it('keeps the old hardware while core restarts, then shows the new answer', async () => {
    const { core, coreHttp } = renderWithStore(<Probe />)
    expect(await screen.findByText(`ram ${exampleHardware.ramBytes}`)).toBeInTheDocument()

    core.emitState({ status: 'starting' })
    expect(screen.getByText(`ram ${exampleHardware.ramBytes}`)).toBeInTheDocument()

    const other: HardwareReport = { gpu: null, ramBytes: 8 * 1024 ** 3 }
    coreHttp.answer('/api/hardware', other)
    core.emitState({ ...ready, connection: { ...exampleConnection, token: 'b'.repeat(64) } })

    expect(await screen.findByText(`ram ${other.ramBytes}`)).toBeInTheDocument()
  })

  it('follows the download queue core streams', async () => {
    const { setup } = renderWithStore(<Probe />, {}, { setup: { downloads: [running] } })
    expect(await screen.findByText('qwen3-4b downloading')).toBeInTheDocument()

    setup.emitDownloads([{ ...running, state: 'paused' }])

    expect(await screen.findByText('qwen3-4b paused')).toBeInTheDocument()
  })

  it('has an empty queue without a connection', async () => {
    renderWithStore(<Probe />, {}, { coreState: { status: 'starting' }, setup: { downloads: [running] } })

    expect(await screen.findByText('empty')).toBeInTheDocument()
  })

  it('reads the catalog again when a download turns done', async () => {
    const { setup, coreHttp } = renderWithStore(<Probe />, {}, { setup: { downloads: [running] } })
    await screen.findByText('qwen3-4b downloading')
    await vi.waitFor(() => expect(catalogRequests(coreHttp.requests)).toBe(1))

    setup.emitDownloads([{ ...running, state: 'done', bytes: 10 }])

    await vi.waitFor(() => expect(catalogRequests(coreHttp.requests)).toBe(2))
  })

  it('reads the catalog again on refreshCatalog', async () => {
    const { coreHttp } = renderWithStore(<Probe />)
    await vi.waitFor(() => expect(catalogRequests(coreHttp.requests)).toBe(1))

    act(() => screen.getByRole('button', { name: 'Refresh' }).click())

    await vi.waitFor(() => expect(catalogRequests(coreHttp.requests)).toBe(2))
  })
})
