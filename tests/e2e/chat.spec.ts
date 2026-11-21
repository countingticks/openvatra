import { execFile } from 'child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { promisify } from 'util'
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { ggufHeader } from './ggufHeader'
import { appArgs, createUserDataDir, removeUserDataDir, seedCoreModels } from './testProfile'

const run = promisify(execFile)

// Sixty words, one chunk each 100 ms apart: about six seconds of answer to hide the window and reload the page in.
const words = Array.from({ length: 60 }, (_, i) => `w${i + 1}`)
const answer = words.join(' ')

let app: ElectronApplication
let mainWindow: Page
let userDataDir: string
let workDir: string

type PageWithApi = { api: { core: { getState(): Promise<{ status: string }> } } }

/** The real core.exe is started by the app; only llama-server is replaced, by the fake server from core/testdata. */
test.beforeAll(async () => {
  workDir = await mkdtemp(join(tmpdir(), 'openvatra-e2e-chat-'))
  const fakeServer = join(workDir, 'fake-server.exe')
  await run('go', ['build', '-C', 'core', '-o', fakeServer, './testdata/fake-server'])
  const modelsDir = join(workDir, 'models')
  await mkdir(modelsDir)
  await writeFile(join(modelsDir, 'tiny.gguf'), ggufHeader('llama'))

  userDataDir = await createUserDataDir()

  app = await electron.launch({
    args: appArgs(userDataDir),
    env: { ...process.env, FAKE_SERVER_REPLY: answer, FAKE_SERVER_TOKEN_DELAY: '100ms' }
  })
  mainWindow = await app.firstWindow()
  await seedCoreModels(userDataDir, { llamaServerPath: fakeServer, modelsDir })
  // Core starts detached and can take several seconds on a busy CI runner; wait for it like models.spec does.
  await expect
    .poll(
      () =>
        mainWindow.evaluate(
          async () => (await (window as unknown as PageWithApi).api.core.getState()).status
        ),
      { timeout: 20_000 }
    )
    .toBe('ready')
})

test.afterAll(async () => {
  await app.close().catch(() => undefined)
  await removeUserDataDir(userDataDir)
  await rm(workDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
})

async function savedRoute(): Promise<string> {
  const text = await readFile(join(userDataDir, 'settings.json'), 'utf8').catch(() => '{}')
  return (JSON.parse(text) as { lastRoute?: string }).lastRoute ?? ''
}

test('an answer keeps streaming through a hidden window and a reloaded page', async () => {
  const message = mainWindow.getByRole('textbox', { name: 'Message' })
  await message.fill('Hello')
  await message.press('Enter')

  const conversation = mainWindow.getByRole('log', { name: 'Conversation' })
  await expect(conversation.getByText('Hello', { exact: true })).toBeVisible()
  await expect(conversation).toContainText(/\bw5\b/)
  await expect.poll(savedRoute).toMatch(/^chat\//)

  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close())
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].show())
  await mainWindow.reload()

  // The same chat opens, and its answer arrives whole: what the partial held plus the deltas after it, once each.
  await expect(mainWindow.getByRole('heading', { level: 1 })).not.toHaveText('New chat')
  const reloaded = mainWindow.getByRole('log', { name: 'Conversation' })
  await expect(reloaded.getByText(answer, { exact: true })).toHaveCount(1, { timeout: 20_000 })
  await expect(reloaded.getByRole('button', { name: 'Copy answer' })).toHaveCount(1)
})
