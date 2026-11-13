import { act, fireEvent, screen, waitFor } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { App } from '@renderer/App'
import { coreWrites } from './fakeCoreHttp'
import { exampleConnection, renderWithStore } from './renderWithStore'
import type { DownloadItem } from '@renderer/core/types'
import type { CatalogEntry } from '@renderer/core/catalogView'

const GB = 1024 ** 3
const ready = { status: 'ready', port: 1234, version: '1', connection: exampleConnection } as const

const entry = (id: string, name: string): CatalogEntry => ({
  id,
  name,
  summary: 's',
  tags: ['chat'],
  licence: 'Apache-2.0',
  sizeBytes: 5 * GB,
  needsGB: 7,
  rank: 1,
  fit: 'fits',
  installed: false,
  diskShortBytes: 0
})
const catalog = {
  entries: [entry('qwen3-8b', 'Qwen3 8B'), entry('small-3b', 'Small 3B')],
  diskFreeBytes: null,
  recommended: null
}
const paused = (id: string): DownloadItem => ({
  id,
  state: 'paused',
  bytes: 2.1 * GB,
  total: 5 * GB,
  speed: 0
})

function start(downloads: DownloadItem[]): ReturnType<typeof renderWithStore> {
  return renderWithStore(<App />, {}, { coreState: ready, setup: { catalog, downloads } })
}

describe('offer to resume unfinished downloads', () => {
  it('asks once about a single paused download, and resumes it', async () => {
    const { coreHttp } = start([paused('qwen3-8b')])

    expect(await screen.findByText(/Qwen3 8B didn't finish downloading \(2\.1 of 5\.0 GB\)/)).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Resume' }))

    await waitFor(() =>
      expect(coreWrites(coreHttp)).toEqual([
        { method: 'POST', path: '/api/downloads/qwen3-8b/resume', body: undefined }
      ])
    )
    expect(screen.queryByRole('button', { name: 'Resume' })).not.toBeInTheDocument()
  })

  it('lists several in one dialog, with Resume all', async () => {
    const { coreHttp } = start([paused('qwen3-8b'), paused('small-3b')])

    expect(await screen.findByText(/Small 3B \(2\.1 of 5\.0 GB\)/)).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Resume all' }))

    await waitFor(() =>
      expect(coreWrites(coreHttp)).toEqual([
        { method: 'POST', path: '/api/downloads/qwen3-8b/resume', body: undefined },
        { method: 'POST', path: '/api/downloads/small-3b/resume', body: undefined }
      ])
    )
  })

  it('"Not now" leaves them paused', async () => {
    const { coreHttp } = start([paused('qwen3-8b')])

    fireEvent.click(await screen.findByRole('button', { name: 'Not now' }))

    expect(screen.queryByRole('button', { name: 'Resume' })).not.toBeInTheDocument()
    expect(coreWrites(coreHttp)).toEqual([])
  })

  it('stays quiet when nothing is paused', async () => {
    start([{ ...paused('qwen3-8b'), state: 'downloading', speed: 1 }])

    await waitFor(() => expect(screen.getByRole('main')).toBeInTheDocument())
    expect(screen.queryByText(/didn't finish downloading/)).not.toBeInTheDocument()
  })

  it('does not ask about a download that pauses later in this run', async () => {
    const { setup } = start([{ ...paused('qwen3-8b'), state: 'downloading', speed: 1 }])
    await waitFor(() => expect(screen.getByRole('main')).toBeInTheDocument())

    setup.emitDownloads([paused('qwen3-8b')])

    expect(screen.queryByText(/didn't finish downloading/)).not.toBeInTheDocument()
  })

  it('waits for core to be ready', async () => {
    renderWithStore(
      <App />,
      {},
      { coreState: { status: 'starting' }, setup: { catalog, downloads: [paused('qwen3-8b')] } }
    )

    await act(async () => {})
    expect(screen.queryByText(/didn't finish downloading/)).not.toBeInTheDocument()
  })
})
