import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { Shell } from '@app/shell/Shell'
import { coreWrites, type FakeCoreHttp } from '../../../fakeCoreHttp'
import { exampleConnection, renderWithStore } from '../../../renderWithStore'
import { settingsOpened } from '@app/store/uiSlice'
import type { Repo } from '@app/core/generated'
import type { DownloadItem } from '@app/core/types'
import type { CatalogEntry, CatalogView } from '@app/features/models/catalogView'

const GB = 1024 ** 3

/** The writes that change something; the GPU card's refresh of the hardware numbers is not about the catalog. */
const writes = (http: FakeCoreHttp): ReturnType<typeof coreWrites> =>
  coreWrites(http).filter((write) => write.path !== '/api/hardware/refresh')
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

/** The tab's own content: the Downloading card above the tabs shows the same controls. */
const panel = (dialog: HTMLElement): Promise<HTMLElement> => within(dialog).findByRole('tabpanel')

/** Settings on Models, with its Get more models tab open; `dialog` is the Settings dialog. */
async function openDialog(
  view: CatalogView,
  downloads: DownloadItem[] = []
): Promise<ReturnType<typeof renderWithStore> & { dialog: HTMLElement }> {
  const rendered = renderWithStore(<Shell />, {}, { coreState: ready, setup: { catalog: view, downloads } })
  act(() => {
    rendered.store.dispatch(settingsOpened({ section: 'models', tab: 'more' }))
  })
  const dialog = await screen.findByRole('dialog', { name: 'Settings' })
  return { ...rendered, dialog }
}

describe('Get more models', () => {
  it('lists each model with tags, size, fit and the Recommended mark, and downloads one', async () => {
    const { coreHttp, dialog } = await openDialog(catalog(qwen, huge, full, have))

    await within(dialog).findByText('Qwen3 8B')
    expect(within(dialog).getByText('Recommended')).toBeInTheDocument()
    expect(within(dialog).getByText('Large')).toBeInTheDocument()
    expect(within(dialog).getAllByText('Fits')).toHaveLength(2)
    expect(within(dialog).getByText('5.0 GB')).toBeInTheDocument()
    expect(within(dialog).getByText('Slower')).toBeInTheDocument()
    expect(within(dialog).queryByText(/Good all-round answers/)).not.toBeInTheDocument()

    fireEvent.click(within(dialog).getByRole('button', { name: 'Download Qwen3 8B' }))
    await waitFor(() =>
      expect(writes(coreHttp)).toEqual([
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
    expect(writes(coreHttp)).toEqual([])
    expect(within(dialog).getByText(/too big for your PC/)).toBeInTheDocument()

    fireEvent.click(within(dialog).getByRole('button', { name: 'Download anyway' }))
    await waitFor(() =>
      expect(writes(coreHttp)).toEqual([
        { method: 'POST', path: '/api/downloads', body: { catalogId: 'big-70b' } }
      ])
    )
  })

  it("can't download a model the disk has no room for", async () => {
    const { dialog } = await openDialog(catalog(qwen, full))

    expect(await within(dialog).findByRole('button', { name: 'Download Mid 14B' })).toBeDisabled()
    expect(within(dialog).getByText(/about 2\.0 GB more is needed/)).toBeInTheDocument()
  })

  it('reads Suggested and Picked to fit this PC in the header', async () => {
    const { dialog } = await openDialog(catalog(qwen))

    expect(await within(dialog).findByText('Suggested')).toBeInTheDocument()
    expect(within(dialog).getByText('Picked to fit this PC')).toBeInTheDocument()
  })

  it('shows the bar and the speed of a downloading row, and Pause sends the pause', async () => {
    const { coreHttp, dialog } = await openDialog(catalog(qwen), [
      {
        id: qwen.id,
        name: 'qwen3-8b.gguf',
        state: 'downloading',
        bytes: 2.1 * GB,
        total: 5 * GB,
        speed: 38 * 1024 ** 2
      }
    ])

    expect(await within(await panel(dialog)).findByText('2.1 of 5.0 GB · 38 MB/s')).toBeInTheDocument()
    expect(
      within(await panel(dialog)).getByRole('progressbar', { name: 'Download progress' })
    ).toBeInTheDocument()
    fireEvent.click(within(await panel(dialog)).getByRole('button', { name: 'Pause Qwen3 8B' }))
    await waitFor(() =>
      expect(writes(coreHttp)).toEqual([
        { method: 'POST', path: '/api/downloads/qwen3-8b/pause', body: undefined }
      ])
    )
  })

  it('offers Resume and Cancel for a paused row, and neither while verifying', async () => {
    const { setup, dialog } = await openDialog(catalog(qwen), [
      { id: qwen.id, name: 'qwen3-8b.gguf', state: 'downloading', bytes: 1 * GB, total: 5 * GB, speed: 0 }
    ])

    await within(await panel(dialog)).findByText('1.0 of 5.0 GB')
    // A queue that starts paused opens the resume dialog; a download that pauses in this run does not.
    setup.emitDownloads([
      { id: qwen.id, name: 'qwen3-8b.gguf', state: 'paused', bytes: 1 * GB, total: 5 * GB, speed: 0 }
    ])
    expect(await within(await panel(dialog)).findByText('Paused · 1.0 of 5.0 GB')).toBeInTheDocument()
    expect(
      await within(await panel(dialog)).findByRole('button', { name: 'Resume Qwen3 8B' })
    ).toBeInTheDocument()
    expect(within(await panel(dialog)).getByRole('button', { name: 'Cancel Qwen3 8B' })).toBeInTheDocument()

    setup.emitDownloads([
      { id: qwen.id, name: 'qwen3-8b.gguf', state: 'verifying', bytes: 5 * GB, total: 5 * GB, speed: 0 }
    ])
    expect(await within(await panel(dialog)).findByText('Checking the download…')).toBeInTheDocument()
    expect(
      within(await panel(dialog)).queryByRole('button', { name: 'Resume Qwen3 8B' })
    ).not.toBeInTheDocument()
    expect(
      within(await panel(dialog)).queryByRole('button', { name: 'Cancel Qwen3 8B' })
    ).not.toBeInTheDocument()
  })

  it('cancels a model being downloaded', async () => {
    const { coreHttp, dialog } = await openDialog(catalog(qwen), [
      { id: qwen.id, name: 'qwen3-8b.gguf', state: 'downloading', bytes: 1 * GB, total: 5 * GB, speed: 0 }
    ])

    expect(await within(await panel(dialog)).findByText('1.0 of 5.0 GB')).toBeInTheDocument()
    fireEvent.click(within(await panel(dialog)).getByRole('button', { name: 'Cancel Qwen3 8B' }))
    await waitFor(() =>
      expect(writes(coreHttp)).toEqual([
        { method: 'DELETE', path: '/api/downloads/qwen3-8b', body: undefined }
      ])
    )
  })

  it('resumes a download that paused in this run', async () => {
    const { coreHttp, setup, dialog } = await openDialog(catalog(qwen), [
      { id: qwen.id, name: 'qwen3-8b.gguf', state: 'downloading', bytes: 1 * GB, total: 5 * GB, speed: 0 }
    ])
    await within(await panel(dialog)).findByText('1.0 of 5.0 GB')

    setup.emitDownloads([
      { id: qwen.id, name: 'qwen3-8b.gguf', state: 'paused', bytes: 1 * GB, total: 5 * GB, speed: 0 }
    ])
    fireEvent.click(await within(await panel(dialog)).findByRole('button', { name: 'Resume Qwen3 8B' }))

    await waitFor(() =>
      expect(writes(coreHttp)).toEqual([
        { method: 'POST', path: '/api/downloads/qwen3-8b/resume', body: undefined }
      ])
    )
  })

  it("opens Settings on the Get more models tab from the welcome card's See other models", async () => {
    renderWithStore(<Shell />, {}, { coreState: ready, setup: { catalog: catalog(qwen) } })

    fireEvent.click(await screen.findByRole('button', { name: 'See other models' }))

    const dialog = await screen.findByRole('dialog', { name: 'Settings' })
    expect(within(dialog).getByRole('tab', { name: 'Get more models' })).toHaveAttribute(
      'aria-selected',
      'true'
    )
    expect(await within(dialog).findByText('Qwen3 8B')).toBeInTheDocument()
  })
})

const repo = (patch: Partial<Repo> = {}): Repo => ({
  id: 'unsloth/Qwen3-Coder-GGUF',
  owner: 'unsloth',
  name: 'Qwen3-Coder-GGUF',
  tags: ['Code'],
  downloads: 1_400_000,
  likes: 230,
  updatedAt: '2026-11-10T12:00:00Z',
  ...patch
})

const searchRequests = (http: FakeCoreHttp): URL[] =>
  http.requests.map((request) => new URL(request.url)).filter((url) => url.pathname === '/api/hf/search')

async function search(dialog: HTMLElement, text: string): Promise<HTMLElement> {
  const field = await within(dialog).findByRole('searchbox', { name: 'Search Hugging Face' })
  fireEvent.change(field, { target: { value: text } })
  return field
}

describe('Get more models: searching Hugging Face', () => {
  it('sends nothing while typing, and the query on Enter', async () => {
    const { coreHttp, dialog } = await openDialog(catalog(qwen))
    coreHttp.answer('/api/hf/search', { repos: [repo()] })

    const field = await search(dialog, 'qwen coder')
    expect(searchRequests(coreHttp)).toHaveLength(0)

    fireEvent.submit(field)
    await within(dialog).findByText('unsloth /')
    expect(searchRequests(coreHttp).map((url) => url.searchParams.get('q'))).toEqual(['qwen coder'])
  })

  it('says where the search goes, before and after searching', async () => {
    const { coreHttp, dialog } = await openDialog(catalog(qwen))
    coreHttp.answer('/api/hf/search', { repos: [repo()] })
    const note = 'Your search goes to huggingface.co. Nothing else leaves your PC.'
    expect(await within(dialog).findByText(note)).toBeInTheDocument()

    fireEvent.submit(await search(dialog, 'qwen'))
    await within(dialog).findByText('unsloth /')

    expect(within(dialog).getByText(note)).toBeInTheDocument()
  })

  it('does not search for a single character', async () => {
    const { coreHttp, dialog } = await openDialog(catalog(qwen))

    fireEvent.submit(await search(dialog, ' q '))

    expect(searchRequests(coreHttp)).toHaveLength(0)
    expect(within(dialog).getByText('Suggested')).toBeInTheDocument()
  })

  it('shows each repo with its counts and age, under a header with the number of results', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-11-24T12:00:00Z'))
    try {
      const { coreHttp, dialog } = await openDialog(catalog(qwen))
      coreHttp.answer('/api/hf/search', {
        repos: [
          repo(),
          repo({ id: 'a/b', owner: 'a', name: 'b' }),
          repo({ id: 'c/d', owner: 'c', name: 'd' })
        ]
      })

      fireEvent.submit(await search(dialog, 'qwen'))

      await within(dialog).findByText('3 results')
      expect(within(dialog).getByText('Hugging Face · GGUF only')).toBeInTheDocument()
      expect(within(dialog).getByText('unsloth /')).toBeInTheDocument()
      expect(within(dialog).getByText('Qwen3-Coder-GGUF')).toBeInTheDocument()
      expect(within(dialog).getAllByText('Code')).toHaveLength(3)
      expect(within(dialog).getAllByLabelText('1.4M downloads')).toHaveLength(3)
      expect(within(dialog).getAllByLabelText('230 likes')).toHaveLength(3)
      expect(within(dialog).getAllByText('2 weeks ago')).toHaveLength(3)
    } finally {
      vi.useRealTimers()
    }
  })

  it('says when Hugging Face could not be reached, and asks again on Enter', async () => {
    const { coreHttp, dialog } = await openDialog(catalog(qwen))
    coreHttp.answer(
      '/api/hf/search',
      { error: 'hf_unreachable', message: 'Hugging Face did not answer.' },
      { status: 502 }
    )

    const field = await search(dialog, 'qwen')
    fireEvent.submit(field)
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      "Hugging Face couldn't be reached. Check your connection and press Enter to try again."
    )
    expect(searchRequests(coreHttp)).toHaveLength(1)

    fireEvent.submit(field)
    await waitFor(() => expect(searchRequests(coreHttp)).toHaveLength(2))
  })

  it('says when nothing matches', async () => {
    const { coreHttp, dialog } = await openDialog(catalog(qwen))
    coreHttp.answer('/api/hf/search', { repos: [] })

    fireEvent.submit(await search(dialog, 'zzz'))

    expect(await within(dialog).findByText('No GGUF models match "zzz".')).toBeInTheDocument()
  })

  it('returns to Suggested on Escape in the field and keeps Settings open', async () => {
    const { coreHttp, dialog } = await openDialog(catalog(qwen))
    coreHttp.answer('/api/hf/search', { repos: [repo()] })
    const field = await search(dialog, 'qwen')
    fireEvent.submit(field)
    await within(dialog).findByText('unsloth /')

    fireEvent.keyDown(field, { key: 'Escape' })

    expect(await within(dialog).findByText('Qwen3 8B')).toBeInTheDocument()
    expect(field).toHaveValue('')
    expect(screen.getByRole('dialog', { name: 'Settings' })).toBeInTheDocument()
  })

  it('returns to Suggested when the field is cleared', async () => {
    const { coreHttp, dialog } = await openDialog(catalog(qwen))
    coreHttp.answer('/api/hf/search', { repos: [repo()] })
    const field = await search(dialog, 'qwen')
    fireEvent.submit(field)
    await within(dialog).findByText('unsloth /')

    fireEvent.change(field, { target: { value: '' } })

    expect(await within(dialog).findByText('Qwen3 8B')).toBeInTheDocument()
  })
})
