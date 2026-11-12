import { createHash } from 'crypto'
import { execFile } from 'child_process'
import { createServer, type Server } from 'http'
import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises'
import type { AddressInfo } from 'net'
import { tmpdir } from 'os'
import { join } from 'path'
import { promisify } from 'util'
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { ggufHeader } from './ggufHeader'
import { appArgs, createUserDataDir, removeUserDataDir } from './testProfile'

const run = promisify(execFile)

let app: ElectronApplication
let mainWindow: Page
let server: Server
let userDataDir: string
let workDir: string

const revision = 'a'.repeat(40)
const fileName = 'tiny-Q4.gguf'
const modelFile = ggufHeader('llama')

/**
 * No internet: a local server plays Hugging Face and serves a tiny fake model; core reads a test catalog that
 * points at it. This works only because main passes --test-catalog solely when unpackaged with OPENVATRA_E2E=1.
 */
test.beforeAll(async () => {
  workDir = await mkdtemp(join(tmpdir(), 'openvatra-e2e-first-'))
  server = createServer((request, response) => {
    if (request.url === `/test/tiny-GGUF/resolve/${revision}/${fileName}`) {
      response.writeHead(200, { 'Content-Length': modelFile.length })
      response.end(modelFile)
    } else {
      response.writeHead(404).end()
    }
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

  const catalogFile = join(workDir, 'catalog.json')
  await writeFile(
    catalogFile,
    JSON.stringify([
      {
        id: 'tiny',
        name: 'Tiny Test Model',
        summary: 'A few bytes, only for tests.',
        tags: ['chat'],
        licence: 'MIT',
        repo: 'test/tiny-GGUF',
        revision,
        files: [
          {
            name: fileName,
            sizeBytes: modelFile.length,
            sha256: createHash('sha256').update(modelFile).digest('hex')
          }
        ],
        needsGB: 1,
        rank: 1,
        baseUrl
      }
    ])
  )

  const fakeServer = join(workDir, 'fake-server.exe')
  await run('go', ['build', '-C', 'core', '-o', fakeServer, './testdata/fake-server'])
  const modelsDir = join(workDir, 'models')
  await mkdir(modelsDir)

  userDataDir = await createUserDataDir()
  // A v6 file, imported into core on its first ready.
  const settings = {
    schemaVersion: 6,
    models: { llamaServerPath: fakeServer, modelsDir }
  }
  await writeFile(join(userDataDir, 'settings.json'), JSON.stringify(settings))

  app = await electron.launch({
    args: appArgs(userDataDir),
    env: { ...process.env, OPENVATRA_E2E: '1', OPENVATRA_TEST_CATALOG: catalogFile }
  })
  mainWindow = await app.firstWindow()
})

test.afterAll(async () => {
  await app.close().catch(() => undefined)
  await new Promise((resolve) => server.close(resolve))
  await removeUserDataDir(userDataDir)
  await rm(workDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
})

test('welcome card → Download → the model shows up in the model button', async () => {
  const welcome = mainWindow.getByRole('region', { name: "Let's get you a model" })
  await expect(welcome).toContainText('Tiny Test Model', { timeout: 20_000 })
  await welcome.getByRole('button', { name: 'Download' }).click()

  // Once the file is checked and in place, the card gives way to the chat.
  await expect(welcome).toBeHidden({ timeout: 20_000 })

  await mainWindow.getByRole('button', { name: /^Model:/ }).click()
  await expect(mainWindow.getByRole('button', { name: /^Load .*tiny/ })).toBeVisible()
})
