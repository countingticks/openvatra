import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { Shell } from '@app/shell/Shell'
import { coreWrites, type FakeCoreHttp } from '../../../fakeCoreHttp'
import { exampleConnection, renderWithStore } from '../../../renderWithStore'
import { settingsOpened } from '@app/store/uiSlice'
import type { Group, Listing, Repo } from '@app/core/generated'
import type { DownloadItem } from '@app/core/types'

const GB = 1024 ** 3
const ready = { status: 'ready', port: 1234, version: '1', connection: exampleConnection } as const
const filesPath = '/api/hf/repos/o/r/files'

const repo: Repo = {
  id: 'o/r',
  owner: 'o',
  name: 'r',
  tags: ['Code'],
  downloads: 1000,
  likes: 10,
  updatedAt: '2026-11-10T12:00:00Z'
}

const group = (patch: Partial<Group> = {}): Group => ({
  quant: 'Q4_K_M',
  sizeBytes: 4 * GB,
  fit: 'fits',
  installed: false,
  files: [],
  ...patch
})

const listing = (groups: Group[], patch: Partial<Listing> = {}): Listing => ({
  repo: 'o/r',
  revision: 'main',
  tags: ['Code'],
  diskFreeBytes: 100 * GB,
  groups,
  ...patch
})

const item = (patch: Partial<DownloadItem> = {}): DownloadItem => ({
  id: 'hf:o/r:Q4_K_M',
  name: 'r-Q4_K_M.gguf',
  state: 'downloading',
  bytes: 38,
  total: 100,
  speed: 0,
  ...patch
})

const fileRequests = (http: FakeCoreHttp): number =>
  http.requests.filter((request) => new URL(request.url).pathname === filesPath).length

const writes = (http: FakeCoreHttp): ReturnType<typeof coreWrites> =>
  coreWrites(http).filter((write) => write.path !== '/api/hardware/refresh')

/** Get more models with a search for "r" answered, and the files of o/r answered with the listing (or a refusal). */
async function openRepo(
  answer: Listing | { status: number; body: unknown },
  downloads: DownloadItem[] = []
): Promise<ReturnType<typeof renderWithStore> & { dialog: HTMLElement; chevron: HTMLElement }> {
  const rendered = renderWithStore(
    <Shell />,
    {},
    {
      coreState: ready,
      setup: { catalog: { entries: [], diskFreeBytes: null, recommended: null }, downloads }
    }
  )
  if ('status' in answer) rendered.coreHttp.answer(filesPath, answer.body, { status: answer.status })
  else rendered.coreHttp.answer(filesPath, answer)
  rendered.coreHttp.answer('/api/hf/search', { repos: [repo] })
  act(() => {
    rendered.store.dispatch(settingsOpened({ section: 'models', tab: 'more' }))
  })
  const dialog = await screen.findByRole('dialog', { name: 'Settings' })
  const field = await within(dialog).findByRole('searchbox', { name: 'Search Hugging Face' })
  fireEvent.change(field, { target: { value: 'qwen' } })
  fireEvent.submit(field)
  const chevron = await within(dialog).findByRole('button', { name: 'Files in o/r' })
  return { ...rendered, dialog, chevron }
}

describe('a Hugging Face repo opened to its quants', () => {
  it('shows Loading files…, then a line per quant with its size and fit', async () => {
    const { dialog, chevron } = await openRepo(
      listing([group(), group({ quant: 'Q8_0', sizeBytes: 8 * GB, fit: 'slower' })])
    )

    fireEvent.click(chevron)
    // Checked synchronously: the fake answers within a few microtasks, so a polling find can miss it on a slow runner.
    expect(within(dialog).getByText('Loading files…')).toBeInTheDocument()

    expect(await within(dialog).findByText('Q4_K_M')).toBeInTheDocument()
    expect(within(dialog).getByText('4.0 GB')).toBeInTheDocument()
    expect(within(dialog).getByText('Fits')).toBeInTheDocument()
    expect(within(dialog).getByText('Q8_0')).toBeInTheDocument()
    expect(within(dialog).getByText('8.0 GB')).toBeInTheDocument()
    expect(within(dialog).getByText('Slower')).toBeInTheDocument()
  })

  it('downloads a quant that fits', async () => {
    const { coreHttp, dialog, chevron } = await openRepo(listing([group()]))
    fireEvent.click(chevron)

    fireEvent.click(await within(dialog).findByRole('button', { name: 'Download o/r Q4_K_M' }))

    await waitFor(() =>
      expect(writes(coreHttp)).toEqual([
        { method: 'POST', path: '/api/downloads', body: { hf: { repo: 'o/r', quant: 'Q4_K_M' } } }
      ])
    )
  })

  it('asks before downloading a quant that is too big, and Not now sends nothing', async () => {
    const { coreHttp, dialog, chevron } = await openRepo(listing([group({ fit: 'tooBig' })]))
    fireEvent.click(chevron)

    fireEvent.click(await within(dialog).findByRole('button', { name: 'Download o/r Q4_K_M' }))
    expect(
      within(dialog).getByText(
        'o/r Q4_K_M is too big for your PC. It will probably be very slow or not work at all. Download it anyway?'
      )
    ).toBeInTheDocument()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Not now' }))

    expect(writes(coreHttp)).toEqual([])
    expect(within(dialog).queryByText(/is too big for your PC/)).not.toBeInTheDocument()
  })

  it("can't download a quant the disk has no room for", async () => {
    const { dialog, chevron } = await openRepo(
      listing([group({ sizeBytes: 9 * GB })], { diskFreeBytes: 10 * GB })
    )
    fireEvent.click(chevron)

    expect(await within(dialog).findByRole('button', { name: 'Download o/r Q4_K_M' })).toBeDisabled()
    expect(
      within(dialog).getByText('Not enough free space: about 1.0 GB more is needed.')
    ).toBeInTheDocument()
  })

  it('shows Installed and no button for an installed quant', async () => {
    const { dialog, chevron } = await openRepo(listing([group({ installed: true })]))
    fireEvent.click(chevron)

    const line = (await within(dialog).findByText('Q4_K_M')).closest('li') as HTMLElement
    expect(within(line).getByText('Installed')).toBeInTheDocument()
    expect(within(line).queryByRole('button')).not.toBeInTheDocument()
  })

  it('shows the bar and the percent of a download, and Cancel removes it', async () => {
    const { coreHttp, dialog, chevron } = await openRepo(listing([group()]), [item()])
    fireEvent.click(chevron)

    expect(await within(dialog).findByText('38%')).toBeInTheDocument()
    expect(within(dialog).getByRole('progressbar', { name: 'Download progress' })).toBeInTheDocument()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel o/r Q4_K_M' }))

    await waitFor(() =>
      expect(writes(coreHttp)).toEqual([
        { method: 'DELETE', path: '/api/downloads/hf%3Ao%2Fr%3AQ4_K_M', body: undefined }
      ])
    )
  })

  it('shows Installed when the download is done, without asking for the files again', async () => {
    const { coreHttp, setup, dialog, chevron } = await openRepo(listing([group()]), [item()])
    fireEvent.click(chevron)
    await within(dialog).findByText('38%')
    expect(fileRequests(coreHttp)).toBe(1)

    setup.emitDownloads([item({ state: 'done', bytes: 100 })])

    expect(await within(dialog).findByText('Installed')).toBeInTheDocument()
    expect(fileRequests(coreHttp)).toBe(1)
  })

  it('says a gated model needs a Hugging Face account', async () => {
    const { dialog, chevron } = await openRepo({
      status: 403,
      body: { error: 'hf_gated', message: 'This model needs a Hugging Face account' }
    })
    fireEvent.click(chevron)

    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'This model needs a Hugging Face account'
    )
  })

  it('adds Vision to the row when the listing has a projector', async () => {
    const { dialog, chevron } = await openRepo(listing([group()], { tags: ['Code', 'Vision'] }))
    expect(within(dialog).queryByText('Vision')).not.toBeInTheDocument()

    fireEvent.click(chevron)

    expect(await within(dialog).findByText('Vision')).toBeInTheDocument()
  })

  it('does not ask for the files again when the repo is closed and opened', async () => {
    const { coreHttp, dialog, chevron } = await openRepo(listing([group()]))
    fireEvent.click(chevron)
    await within(dialog).findByText('Q4_K_M')

    fireEvent.click(chevron)
    expect(within(dialog).queryByText('Q4_K_M')).not.toBeInTheDocument()
    fireEvent.click(chevron)

    expect(await within(dialog).findByText('Q4_K_M')).toBeInTheDocument()
    expect(fileRequests(coreHttp)).toBe(1)
  })
})
