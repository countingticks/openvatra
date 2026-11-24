import { createHash } from 'crypto'
import { createServer, type Server } from 'http'
import { access, mkdir, mkdtemp, rm } from 'fs/promises'
import type { AddressInfo } from 'net'
import { tmpdir } from 'os'
import { join } from 'path'
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { ggufHeader } from './ggufHeader'
import { appArgs, createUserDataDir, removeUserDataDir, seedCoreModels } from './testProfile'

let app: ElectronApplication
let mainWindow: Page
let server: Server
let userDataDir: string
let workDir: string
let modelsDir: string
/** Every request the fake Hugging Face got. */
const requests: string[] = []
/** Each request's path with the Range header it carried ('' when none). */
const ranges: { path: string; range: string }[] = []

const sha = 'b'.repeat(40)
const fileName = 'tiny-Q4_K_M.gguf'
const modelFile = ggufHeader('llama')
/** A file that holds only its model's MTP draft layer: core must refuse it before it downloads. */
const draftName = 'draft-MTP.BF16.gguf'
const draftFile = ggufHeader('llama', { blockCount: 49, nextn: 1, blocks: [48] })
const draftResolve = `/test/draft-GGUF/resolve/${sha}/${draftName}`

const repoHit = (id: string): Record<string, unknown> => ({
  id,
  lastModified: new Date().toISOString(),
  likes: 5,
  downloads: 1400,
  tags: ['gguf'],
  pipeline_tag: 'text-generation'
})
const treeEntry = (path: string, file: Buffer): Record<string, unknown> => ({
  type: 'file',
  size: file.length,
  path,
  lfs: { oid: createHash('sha256').update(file).digest('hex') }
})

/**
 * No internet: a local server plays Hugging Face (search, repo info, file tree and the file itself) and counts what
 * it gets. This works only because main passes --hf-base solely when unpackaged with OPENVATRA_E2E=1.
 */
test.beforeAll(async () => {
  workDir = await mkdtemp(join(tmpdir(), 'openvatra-e2e-hf-'))
  server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    requests.push(url.pathname)
    ranges.push({ path: url.pathname, range: request.headers.range ?? '' })
    const json = (body: unknown): void => {
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify(body))
    }
    if (url.pathname === '/api/models') {
      json([repoHit('test/tiny-GGUF'), repoHit('test/draft-GGUF')])
    } else if (url.pathname === '/api/models/test/tiny-GGUF') {
      json({ id: 'test/tiny-GGUF', private: false, tags: ['gguf'], sha, gated: false })
    } else if (url.pathname === `/api/models/test/tiny-GGUF/tree/${sha}`) {
      json([treeEntry(fileName, modelFile)])
    } else if (url.pathname === `/test/tiny-GGUF/resolve/${sha}/${fileName}`) {
      response.writeHead(200, { 'Content-Length': modelFile.length })
      response.end(modelFile)
    } else if (url.pathname === '/api/models/test/draft-GGUF') {
      json({ id: 'test/draft-GGUF', private: false, tags: ['gguf'], sha, gated: false })
    } else if (url.pathname === `/api/models/test/draft-GGUF/tree/${sha}`) {
      json([treeEntry(draftName, draftFile)])
    } else if (url.pathname === draftResolve) {
      response.writeHead(200, { 'Content-Length': draftFile.length })
      response.end(draftFile)
    } else {
      response.writeHead(404).end()
    }
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

  modelsDir = join(workDir, 'models')
  await mkdir(modelsDir)
  userDataDir = await createUserDataDir()
  app = await electron.launch({
    args: appArgs(userDataDir),
    env: { ...process.env, OPENVATRA_E2E: '1', OPENVATRA_TEST_HF: baseUrl }
  })
  mainWindow = await app.firstWindow()
  await seedCoreModels(userDataDir, { modelsDir })
})

test.afterAll(async () => {
  await app.close().catch(() => undefined)
  await new Promise((resolve) => server.close(resolve))
  await removeUserDataDir(userDataDir)
  await rm(workDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
})

test('search → expand → Download → the model is in Installed, and nothing left before Enter', async () => {
  await mainWindow.keyboard.press('Control+,')
  const dialog = mainWindow.getByRole('dialog', { name: 'Settings' })
  await dialog.getByRole('navigation', { name: 'Settings sections' }).getByText('Models').click()
  await dialog.getByRole('tab', { name: 'Get more models' }).click()

  const field = dialog.getByRole('searchbox', { name: 'Search Hugging Face' })
  await field.fill('tiny')
  // Typing alone must send nothing (the unit tests cover it over time; here: nothing before Enter).
  await expect(field).toHaveValue('tiny')
  expect(requests).toHaveLength(0)

  await field.press('Enter')
  await dialog.getByRole('button', { name: 'Files in test/tiny-GGUF' }).click()
  await dialog.getByRole('button', { name: 'Download test/tiny-GGUF Q4_K_M' }).click()

  const line = dialog.getByRole('listitem').filter({ hasText: 'Q4_K_M' })
  await expect(line.getByText('Installed')).toBeVisible({ timeout: 30_000 })

  await dialog.getByRole('tab', { name: /^Installed/ }).click()
  await expect(dialog.getByRole('button', { name: /^Options for .*tiny/i })).toBeVisible()

  await access(join(modelsDir, 'hf', 'test', 'tiny-GGUF', 'Q4_K_M', fileName))
})

test('Download of a draft-only file says why and downloads nothing', async () => {
  const dialog = mainWindow.getByRole('dialog', { name: 'Settings' })
  if (!(await dialog.isVisible())) {
    await mainWindow.keyboard.press('Control+,')
    await dialog.getByRole('navigation', { name: 'Settings sections' }).getByText('Models').click()
  }
  await dialog.getByRole('tab', { name: 'Get more models' }).click()

  const field = dialog.getByRole('searchbox', { name: 'Search Hugging Face' })
  await field.fill('draft')
  await field.press('Enter')
  await dialog.getByRole('button', { name: 'Files in test/draft-GGUF' }).click()
  await dialog.getByRole('button', { name: 'Download test/draft-GGUF BF16' }).click()

  const line = dialog.getByRole('listitem').filter({ hasText: 'BF16' })
  await expect(line.getByRole('alert')).toContainText('Not a complete model: it holds 1 of 49 layers.')
  expect(ranges.filter((r) => r.path === draftResolve)).toEqual([
    { path: draftResolve, range: 'bytes=0-67108863' }
  ])
  await expect(access(join(modelsDir, 'hf', 'test', 'draft-GGUF'))).rejects.toThrow()
  await expect(dialog.getByRole('button', { name: 'Download test/draft-GGUF BF16' })).toBeVisible()
})
