import { fireEvent, screen, waitFor } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { App } from '@renderer/App'
import { coreWrites } from './fakeCoreHttp'
import { exampleConnection, renderWithStore } from './renderWithStore'
import type { ModelInfo } from '../../src/shared/core'
import type { CatalogEntry, CatalogView, DownloadItem } from '../../src/shared/setup'

const GB = 1024 ** 3
const ready = { status: 'ready', port: 1234, version: '1', connection: exampleConnection } as const

const qwen: CatalogEntry = {
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
  diskShortBytes: 0
}
const catalog: CatalogView = { entries: [qwen], diskFreeBytes: 100 * GB, recommended: qwen.id }

const item = (patch: Partial<DownloadItem> = {}): DownloadItem => ({
  id: qwen.id,
  state: 'downloading',
  bytes: 4.1 * GB,
  total: 5 * GB,
  speed: 0.5 * GB,
  ...patch
})

const chatModel: ModelInfo = {
  id: 'Qwen3-8B',
  state: 'stopped',
  busy: false,
  sizeBytes: 5 * GB,
  kind: 'chat'
}

describe('welcome card', () => {
  it('recommends a model with its size and fit, and downloads it on click', async () => {
    const { coreHttp } = renderWithStore(<App />, {}, { coreState: ready, setup: { catalog } })

    expect(await screen.findByRole('heading', { name: "Let's get you a model" })).toBeInTheDocument()
    expect(screen.getByText(/RTX 4070 · 12 GB graphics memory · 32 GB memory/)).toBeInTheDocument()
    expect(screen.getByText('Qwen3 8B')).toBeInTheDocument()
    expect(screen.getByText('5.0 GB · Fits your PC')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Download' }))
    await waitFor(() =>
      expect(coreWrites(coreHttp)).toEqual([
        { method: 'POST', path: '/api/downloads', body: { catalogId: 'qwen3-8b' } }
      ])
    )
  })

  it('shows progress with time left while downloading, and cancels', async () => {
    const { coreHttp } = renderWithStore(
      <App />,
      {},
      { coreState: ready, setup: { catalog, downloads: [item()] } }
    )

    expect(await screen.findByRole('status')).toHaveTextContent('4.1 of 5.0 GB · less than a minute left')
    expect(screen.getByRole('progressbar', { name: 'Download progress' })).toHaveValue(82)

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await waitFor(() =>
      expect(coreWrites(coreHttp)).toEqual([
        { method: 'DELETE', path: '/api/downloads/qwen3-8b', body: undefined }
      ])
    )
  })

  it('offers Resume when paused and Try again after an error', async () => {
    const { coreHttp, setup } = renderWithStore(
      <App />,
      {},
      { coreState: ready, setup: { catalog, downloads: [item({ state: 'paused' })] } }
    )
    // Paused at start, so the resume offer opens once the catalog is in; its button is the one to press.
    await screen.findByRole('dialog')
    fireEvent.click(screen.getByRole('button', { name: 'Resume' }))
    await waitFor(() =>
      expect(coreWrites(coreHttp)).toEqual([
        { method: 'POST', path: '/api/downloads/qwen3-8b/resume', body: undefined }
      ])
    )

    setup.emitDownloads([item({ state: 'error', error: 'the connection dropped' })])
    expect(await screen.findByText('The download stopped: the connection dropped')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    await waitFor(() => expect(coreWrites(coreHttp)).toHaveLength(2))
    expect(coreWrites(coreHttp)[1]).toEqual({
      method: 'POST',
      path: '/api/downloads/qwen3-8b/resume',
      body: undefined
    })
  })

  it('says so when no model fits, without a Download button', async () => {
    renderWithStore(
      <App />,
      {},
      {
        coreState: ready,
        setup: { catalog: { entries: [{ ...qwen, fit: 'tooBig' }], diskFreeBytes: null, recommended: null } }
      }
    )

    expect(await screen.findByText(/None of the models we offer will run well/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Download' })).not.toBeInTheDocument()
  })

  it('disables Download and explains when the disk is too full', async () => {
    renderWithStore(
      <App />,
      {},
      {
        coreState: ready,
        setup: { catalog: { ...catalog, entries: [{ ...qwen, diskShortBytes: 2 * GB }] } }
      }
    )

    expect(await screen.findByRole('alert')).toHaveTextContent('about 2.0 GB more is needed')
    expect(screen.getByRole('button', { name: 'Download' })).toBeDisabled()
  })

  it('shows the reason when core refuses the download', async () => {
    const { coreHttp } = renderWithStore(<App />, {}, { coreState: ready, setup: { catalog } })
    coreHttp.respond('POST', '/api/downloads', () => ({
      status: 409,
      body: { error: 'not_enough_space', message: 'no space' }
    }))

    fireEvent.click(await screen.findByRole('button', { name: 'Download' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('no space')
  })

  it("shows core's models folder", async () => {
    renderWithStore(
      <App />,
      {},
      { coreState: ready, setup: { catalog }, modelSettings: { modelsDir: 'D:\\AI' } }
    )

    expect(await screen.findByText(/saved in D:\\AI\./)).toBeInTheDocument()
  })

  it('changes the folder through the system dialog', async () => {
    const { pick } = renderWithStore(<App />, {}, { coreState: ready, setup: { catalog } })
    expect(await screen.findByText(/OpenVatra\\Models folder/)).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Change…' }))

    await waitFor(() => expect(pick).toHaveBeenCalledWith('modelsDir'))
  })

  it('is not shown once there is a chat model, or while the service is starting', async () => {
    renderWithStore(<App />, {}, { coreState: ready, models: [chatModel], setup: { catalog } })
    expect(await screen.findByRole('heading', { name: 'Chat' })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: "Let's get you a model" })).not.toBeInTheDocument()
  })
})
