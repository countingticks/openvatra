import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { App } from '@renderer/App'
import { coreWrites } from './fakeCoreHttp'
import { exampleConnection, renderWithStore } from './renderWithStore'
import type { CatalogEntry, CatalogView, DownloadItem } from '../../src/shared/setup'

const GB = 1024 ** 3
const ready = { status: 'ready', port: 1234, version: '1', connection: exampleConnection } as const

const entry = (patch: Partial<CatalogEntry>): CatalogEntry => ({
  id: 'qwen3-8b',
  name: 'Qwen3 8B',
  summary: 'Good all-round answers.',
  tags: ['chat'],
  licence: 'Apache-2.0',
  sizeBytes: 5 * GB,
  needsGB: 7,
  rank: 1,
  fit: 'fits',
  installed: false,
  diskShortBytes: 0,
  ...patch
})
const qwen = entry({})
const huge = entry({
  id: 'big-70b',
  name: 'Big 70B',
  sizeBytes: 40 * GB,
  fit: 'tooBig',
  tags: ['chat', 'large']
})
const full = entry({ id: 'mid-14b', name: 'Mid 14B', sizeBytes: 9 * GB, diskShortBytes: 2 * GB })
const have = entry({ id: 'small-3b', name: 'Small 3B', sizeBytes: 2 * GB, fit: 'slower', installed: true })

const catalog = (...entries: CatalogEntry[]): CatalogView => ({
  entries,
  diskFreeBytes: 100 * GB,
  recommended: qwen.id
})

async function openDialog(
  view: CatalogView,
  downloads: DownloadItem[] = []
): Promise<ReturnType<typeof renderWithStore> & { dialog: HTMLElement }> {
  const rendered = renderWithStore(<App />, {}, { coreState: ready, setup: { catalog: view, downloads } })
  fireEvent.click(await screen.findByRole('button', { name: 'See other models' }))
  const dialog = await screen.findByRole('dialog', { name: 'Get more models' })
  return { ...rendered, dialog }
}

describe('Models dialog', () => {
  it('lists each model with tags, size, fit and the Recommended mark, and downloads one', async () => {
    const { coreHttp, dialog } = await openDialog(catalog(qwen, huge, full, have))

    await within(dialog).findByText('Qwen3 8B')
    expect(within(dialog).getByText('Recommended')).toBeInTheDocument()
    expect(within(dialog).getByText('large')).toBeInTheDocument()
    expect(within(dialog).getByText('5.0 GB · Fits your PC')).toBeInTheDocument()
    expect(within(dialog).getByText('2.0 GB · Will run, but slowly')).toBeInTheDocument()

    fireEvent.click(within(dialog).getByRole('button', { name: 'Download Qwen3 8B' }))
    await waitFor(() =>
      expect(coreWrites(coreHttp)).toEqual([
        { method: 'POST', path: '/api/downloads', body: { catalogId: 'qwen3-8b' } }
      ])
    )
  })

  it("shows core's reason when it refuses a download", async () => {
    const { coreHttp, dialog } = await openDialog(catalog(qwen))
    coreHttp.respond('POST', '/api/downloads', () => ({
      status: 409,
      body: { error: 'not_enough_space', message: 'Not enough free space for Qwen3 8B.' }
    }))

    fireEvent.click(await within(dialog).findByRole('button', { name: 'Download Qwen3 8B' }))

    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Not enough free space for Qwen3 8B.')
  })

  it('asks before downloading a model that is too big for the PC', async () => {
    const { coreHttp, dialog } = await openDialog(catalog(qwen, huge))

    fireEvent.click(await within(dialog).findByRole('button', { name: 'Download Big 70B' }))
    expect(coreWrites(coreHttp)).toEqual([])
    expect(within(dialog).getByText(/too big for your PC/)).toBeInTheDocument()

    fireEvent.click(within(dialog).getByRole('button', { name: 'Download anyway' }))
    await waitFor(() =>
      expect(coreWrites(coreHttp)).toEqual([
        { method: 'POST', path: '/api/downloads', body: { catalogId: 'big-70b' } }
      ])
    )
  })

  it("can't download a model the disk has no room for", async () => {
    const { dialog } = await openDialog(catalog(qwen, full))

    expect(await within(dialog).findByRole('button', { name: 'Download Mid 14B' })).toBeDisabled()
    expect(within(dialog).getByText(/about 2\.0 GB more is needed/)).toBeInTheDocument()
  })

  it('shows progress and Cancel for a model being downloaded', async () => {
    const { coreHttp, dialog } = await openDialog(catalog(qwen), [
      { id: qwen.id, state: 'downloading', bytes: 1 * GB, total: 5 * GB, speed: 0 }
    ])

    expect(await within(dialog).findByText('1.0 of 5.0 GB')).toBeInTheDocument()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    await waitFor(() =>
      expect(coreWrites(coreHttp)).toEqual([
        { method: 'DELETE', path: '/api/downloads/qwen3-8b', body: undefined }
      ])
    )
  })

  it('resumes a download that paused in this run', async () => {
    const { coreHttp, setup, dialog } = await openDialog(catalog(qwen), [
      { id: qwen.id, state: 'downloading', bytes: 1 * GB, total: 5 * GB, speed: 0 }
    ])
    await within(dialog).findByText('1.0 of 5.0 GB')

    setup.emitDownloads([{ id: qwen.id, state: 'paused', bytes: 1 * GB, total: 5 * GB, speed: 0 }])
    fireEvent.click(await within(dialog).findByRole('button', { name: 'Resume' }))

    await waitFor(() =>
      expect(coreWrites(coreHttp)).toEqual([
        { method: 'POST', path: '/api/downloads/qwen3-8b/resume', body: undefined }
      ])
    )
  })

  it('removes an installed model only after confirming, saying what it frees', async () => {
    const { coreHttp, dialog } = await openDialog(catalog(qwen, have))
    const catalogReads = (): number =>
      coreHttp.requests.filter((request) => request.method === 'GET' && request.url.endsWith('/api/catalog'))
        .length

    expect(await within(dialog).findByText('Installed')).toBeInTheDocument()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove Small 3B' }))
    expect(coreWrites(coreHttp)).toEqual([])
    expect(within(dialog).getByText(/frees about 2\.0 GB/)).toBeInTheDocument()
    const readsBefore = catalogReads()

    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove it' }))
    await waitFor(() =>
      expect(coreWrites(coreHttp)).toEqual([
        { method: 'POST', path: '/api/catalog/small-3b/remove', body: undefined }
      ])
    )
    await waitFor(() => expect(catalogReads()).toBe(readsBefore + 1))
  })

  it('keeps the model when the confirmation is declined', async () => {
    const { coreHttp, dialog } = await openDialog(catalog(qwen, have))

    fireEvent.click(await within(dialog).findByRole('button', { name: 'Remove Small 3B' }))
    fireEvent.click(within(dialog).getByRole('button', { name: 'Keep it' }))
    expect(coreWrites(coreHttp)).toEqual([])
    expect(within(dialog).queryByText(/frees about/)).not.toBeInTheDocument()
  })

  it('opens from the model button and from Settings → Models', async () => {
    renderWithStore(
      <App />,
      {},
      {
        coreState: ready,
        setup: { catalog: catalog(qwen) },
        models: [{ id: 'm', state: 'stopped', busy: false, sizeBytes: GB, kind: 'chat' }]
      }
    )
    fireEvent.click(await screen.findByRole('button', { name: /^Model:/ }))
    fireEvent.click(await screen.findByRole('button', { name: 'Get more models…' }))
    expect(await screen.findByRole('dialog', { name: 'Get more models' })).toBeInTheDocument()
  })
})
