import { execFile } from 'child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { promisify } from 'util'
import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Locator,
  type Page
} from '@playwright/test'
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

  await launch(() => seedCoreModels(userDataDir, { llamaServerPath: fakeServer, modelsDir }))
})

/** Starts the app on this test's profile and waits for core; `beforeReady` runs once the window is up. */
async function launch(beforeReady: () => Promise<void> = async () => {}): Promise<void> {
  app = await electron.launch({
    args: appArgs(userDataDir),
    env: { ...process.env, FAKE_SERVER_REPLY: answer, FAKE_SERVER_TOKEN_DELAY: '100ms' }
  })
  mainWindow = await app.firstWindow()
  await beforeReady()
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
}

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

test('a chat keeps its model-made title across a restart and opens from the sidebar', async () => {
  // The fake server answers the title call with its reply's first words.
  const row = (page: Page): Locator =>
    page.getByRole('list', { name: 'Chats' }).getByRole('button', { name: /^w1 w2/ })
  await expect(row(mainWindow)).toBeVisible({ timeout: 20_000 })
  const title = (await row(mainWindow).getAttribute('title')) ?? ''
  expect(title).not.toBe('Hello')

  await app.close()
  await launch()

  await mainWindow.getByRole('button', { name: 'New chat' }).click()
  await expect(mainWindow.getByRole('heading', { level: 1 })).toHaveText('New chat')
  await row(mainWindow).click()

  const conversation = mainWindow.getByRole('log', { name: 'Conversation' })
  await expect(conversation.getByText('Hello', { exact: true })).toBeVisible()
  await expect(conversation.getByText(answer, { exact: true })).toHaveCount(1)
  await expect(mainWindow.getByRole('heading', { level: 1 })).toHaveText(title)
})

test('Copy puts the answer on the clipboard, and deleting the open chat opens a new one', async () => {
  // navigator.clipboard refuses a page without focus.
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].focus())
  const heading = mainWindow.getByRole('heading', { level: 1 })
  const title = (await heading.textContent()) ?? ''
  const conversation = mainWindow.getByRole('log', { name: 'Conversation' })
  await conversation.getByRole('button', { name: 'Copy answer' }).click()
  await expect.poll(() => app.evaluate(({ clipboard }) => clipboard.readText())).toBe(answer)

  const chats = mainWindow.getByRole('list', { name: 'Chats' })
  await chats.getByRole('button', { name: `Actions for ${title}` }).click()
  await mainWindow.getByRole('menuitem', { name: 'Delete' }).click()
  await mainWindow.getByRole('dialog').getByRole('button', { name: 'Delete' }).click()

  await expect(heading).toHaveText('New chat')
  await expect(chats.getByRole('button', { name: `Actions for ${title}` })).toHaveCount(0)
  await expect(mainWindow.getByRole('textbox', { name: 'Message' })).toBeFocused()
})

test('Rewind removes the second turn and puts its text in the message box in place of the draft', async () => {
  const box = mainWindow.getByRole('textbox', { name: 'Message' })
  const conversation = mainWindow.getByRole('log', { name: 'Conversation' })
  const copies = conversation.getByRole('button', { name: 'Copy answer' })

  await box.fill('First')
  await box.press('Enter')
  await expect(copies).toHaveCount(1, { timeout: 20_000 })
  // An input sent while the first run still finishes (its title step) queues into it: wait until the run is over.
  await expect(conversation.getByRole('button', { name: 'Rewind message' })).not.toHaveAttribute(
    'aria-disabled',
    'true',
    { timeout: 20_000 }
  )
  await box.fill('Second')
  await box.press('Enter')
  await expect(copies).toHaveCount(2, { timeout: 20_000 })

  await box.fill('half typed')
  await conversation.getByRole('button', { name: 'Rewind message' }).nth(1).click()

  await expect(conversation.getByText('Second', { exact: true })).toHaveCount(0)
  await expect(copies).toHaveCount(1)
  await expect(conversation.getByText('First', { exact: true })).toBeVisible()
  await expect(box).toHaveValue('Second')
  await expect(box).toBeFocused()
})
