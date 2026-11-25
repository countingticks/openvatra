import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { coreWrites } from '../../../fakeCoreHttp'
import type { DownloadItem } from '@app/core/types'
import type { CatalogEntry, CatalogView } from '@app/features/models/catalogView'
import { chosen, openModels, ready } from './openModelsSection'

const GB = 1024 ** 3

const entry: CatalogEntry = {
  id: 'qwen3-8b',
  name: 'Qwen3 8B',
  summary: 's',
  tags: ['chat'],
  licence: 'Apache-2.0',
  sizeBytes: 5 * GB,
  needsGB: 7,
  rank: 1,
  fit: 'fits',
  installed: false,
  diskShortBytes: 0
}
const catalog: CatalogView = { entries: [entry], diskFreeBytes: null, recommended: null }

const item = (patch: Partial<DownloadItem>): DownloadItem => ({
  id: 'qwen3-8b',
  name: 'qwen3-8b.gguf',
  state: 'downloading',
  bytes: 1 * GB,
  total: 5 * GB,
  speed: 38 * 1024 ** 2,
  ...patch
})

const open = (downloads: DownloadItem[]): ReturnType<typeof openModels> =>
  openModels(chosen, { coreState: ready, setup: { catalog, downloads } })

const card = (): HTMLElement => screen.getByRole('region', { name: 'Downloading' })
const noCard = (): void => {
  expect(screen.queryByRole('region', { name: 'Downloading' })).not.toBeInTheDocument()
}

describe('the Downloading card', () => {
  it('is not there while nothing is downloading, or only the engine or finished items are', async () => {
    await open([
      item({ id: 'engine-cuda', name: 'CUDA engine' }),
      item({ id: 'small-3b', name: 'small.gguf', state: 'done' })
    ])
    await screen.findByRole('group', { name: 'Graphics card' })
    noCard()
  })

  it("shows a catalog download's name, bar and speed, and Pause posts the pause", async () => {
    const { coreHttp } = await open([item({})])

    const region = await screen.findByRole('region', { name: 'Downloading' })
    expect(within(region).getByText('Qwen3 8B')).toBeInTheDocument()
    expect(within(region).getByRole('progressbar', { name: 'Download progress' })).toBeInTheDocument()
    expect(within(region).getByText('1.0 of 5.0 GB · 38 MB/s')).toBeInTheDocument()
    fireEvent.click(within(region).getByRole('button', { name: 'Pause Qwen3 8B' }))

    await waitFor(() =>
      expect(coreWrites(coreHttp).filter((write) => write.path.endsWith('/pause'))).toEqual([
        { method: 'POST', path: '/api/downloads/qwen3-8b/pause', body: undefined }
      ])
    )
  })

  it('names a Hugging Face download repo · quant, and Cancel deletes it', async () => {
    const { coreHttp } = await open([item({ id: 'hf:o/r:Q4_K_M', name: 'r-Q4_K_M.gguf' })])

    const region = await screen.findByRole('region', { name: 'Downloading' })
    expect(within(region).getByText('o/r · Q4_K_M')).toBeInTheDocument()
    fireEvent.click(within(region).getByRole('button', { name: 'Cancel o/r · Q4_K_M' }))

    await waitFor(() =>
      expect(coreWrites(coreHttp).filter((write) => write.method === 'DELETE')).toEqual([
        { method: 'DELETE', path: '/api/downloads/hf%3Ao%2Fr%3AQ4_K_M', body: undefined }
      ])
    )
  })

  it("shows the queue's own name for an id that is neither in the catalog nor from Hugging Face", async () => {
    await open([item({ id: 'mystery', name: 'mystery.gguf' })])

    expect(
      within(await screen.findByRole('region', { name: 'Downloading' })).getByText('mystery.gguf')
    ).toBeInTheDocument()
  })

  it('offers Resume for a paused item and Try again for one that failed', async () => {
    const { coreHttp, setup } = await open([item({})])
    const region = await screen.findByRole('region', { name: 'Downloading' })
    // A queue that starts paused opens the resume dialog; a download that pauses in this run does not.
    setup.emitDownloads([item({ state: 'paused', speed: 0 })])
    await within(region).findByText(/^Paused/)
    fireEvent.click(within(region).getByRole('button', { name: 'Resume Qwen3 8B' }))
    await waitFor(() =>
      expect(coreWrites(coreHttp).filter((write) => write.path.endsWith('/resume'))).toEqual([
        { method: 'POST', path: '/api/downloads/qwen3-8b/resume', body: undefined }
      ])
    )

    setup.emitDownloads([item({ state: 'error', error: 'disk full', speed: 0 })])
    await within(region).findByText(/The download stopped: disk full/)
    expect(within(region).getByRole('button', { name: 'Resume Qwen3 8B' })).toHaveTextContent('Try again')
  })

  it("shows core's message under the row when Pause is refused", async () => {
    const { coreHttp } = await open([item({})])
    coreHttp.respond('POST', '/api/downloads/qwen3-8b/pause', () => ({
      status: 409,
      body: { error: 'conflict', message: 'Cannot pause right now.' }
    }))

    const region = await screen.findByRole('region', { name: 'Downloading' })
    fireEvent.click(within(region).getByRole('button', { name: 'Pause Qwen3 8B' }))

    expect(await within(region).findByRole('alert')).toHaveTextContent('Cannot pause right now.')
  })

  it('drops a row when it is done, and the card with the last row', async () => {
    const { setup } = await open([
      item({}),
      item({ id: 'small-3b', name: 'small-3b.gguf', state: 'queued', bytes: 0, speed: 0 })
    ])
    const region = await screen.findByRole('region', { name: 'Downloading' })
    expect(within(region).getAllByRole('listitem')).toHaveLength(2)

    setup.emitDownloads([
      item({ state: 'done', bytes: 5 * GB }),
      item({ id: 'small-3b', name: 'small-3b.gguf', state: 'queued', bytes: 0, speed: 0 })
    ])
    await waitFor(() => expect(within(card()).getAllByRole('listitem')).toHaveLength(1))

    setup.emitDownloads([item({ state: 'done', bytes: 5 * GB })])
    await waitFor(noCard)
  })

  it('is there on the Installed tab and on Get more models', async () => {
    await open([item({})])
    await screen.findByRole('region', { name: 'Downloading' })

    fireEvent.click(screen.getByRole('tab', { name: /Get more models/ }))
    await screen.findByRole('searchbox', { name: 'Search Hugging Face' })
    expect(card()).toBeInTheDocument()

    fireEvent.click(screen.getByRole('tab', { name: /Installed/ }))
    expect(card()).toBeInTheDocument()
  })

  it('comes after the Graphics card and before the Models folder', async () => {
    await open([item({})])
    const region = await screen.findByRole('region', { name: 'Downloading' })
    const gpu = screen.getByRole('group', { name: 'Graphics card' })
    const folder = screen.getByText('Models folder')

    expect(gpu.compareDocumentPosition(region) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(region.compareDocumentPosition(folder) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })
})
