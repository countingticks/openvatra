import { execFile } from 'child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import { promisify } from 'util'
import { _electron as electron, expect, test, type Page } from '@playwright/test'
import { installPerfProbe } from '../../src/shared/perfProbe'
import { ggufHeader } from '../e2e/ggufHeader'
import { appArgs, createUserDataDir, removeUserDataDir, seedCoreModels } from '../e2e/testProfile'
import type { ScenarioResult } from './result'
import { selectScenarios, type Scenario } from './scenarios'

const run = promisify(execFile)

const selected = selectScenarios((process.env.PERF_SCENARIOS ?? '').split(',').filter(Boolean))
const durationS = Number(process.env.PERF_DURATION || '15')
const resultsDir = resolve('test-results', 'perf')
const answerFile = resolve('tests', 'perf', 'fixtures', 'answer.md')

let workDir: string
let fakeServer: string
let modelsDir: string

test.beforeAll(async () => {
  workDir = await mkdtemp(join(tmpdir(), 'openvatra-perf-'))
  fakeServer = join(workDir, 'fake-server.exe')
  await run('go', ['build', '-C', 'core', '-o', fakeServer, './testdata/fake-server'])
  modelsDir = join(workDir, 'models')
  await mkdir(modelsDir)
  await writeFile(join(modelsDir, 'tiny.gguf'), ggufHeader('llama'))
})

test.afterAll(async () => {
  if (workDir) await rm(workDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
})

type PageWithApi = { api: { core: { getState(): Promise<{ status: string }> } } }

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** "The answer has started": the conversation grew by at least 20 characters past the user's message. */
async function waitForAnswerStart(page: Page, timeoutMs: number): Promise<void> {
  const conversation = page.getByRole('log', { name: 'Conversation' })
  await expect(conversation.getByText('Hello', { exact: true })).toBeVisible()
  const base = (await conversation.innerText()).length
  try {
    await expect
      .poll(async () => (await conversation.innerText()).length, { timeout: timeoutMs })
      .toBeGreaterThan(base + 19)
  } catch {
    throw new Error(`no answer within ${timeoutMs / 1000} s`)
  }
}

async function runFake(scenario: Scenario): Promise<ScenarioResult> {
  const dir = await createUserDataDir()
  const app = await electron.launch({
    args: appArgs(dir),
    env: {
      ...process.env,
      FAKE_SERVER_REPLY_FILE: answerFile,
      FAKE_SERVER_TOKEN_DELAY: scenario.tokenDelay,
      FAKE_SERVER_BURN_CPU: String(scenario.burnCpu)
    }
  })
  try {
    const page = await app.firstWindow()
    await seedCoreModels(dir, { llamaServerPath: fakeServer, modelsDir })
    await expect
      .poll(
        () =>
          page.evaluate(async () => (await (window as unknown as PageWithApi).api.core.getState()).status),
        { timeout: 20_000 }
      )
      .toBe('ready')
    await page.evaluate(installPerfProbe)

    const message = page.getByRole('textbox', { name: 'Message' })
    await message.fill('Hello')
    await message.press('Enter')
    if (scenario.name === 'idle') {
      await expect(page.getByRole('button', { name: 'Copy answer' }).first()).toBeVisible({ timeout: 30_000 })
    } else {
      await waitForAnswerStart(page, 30_000)
    }
    await sleep(2000)

    await page.evaluate(() => window.__perf?.reset())
    await sleep(durationS * 1000)
    const probe = await page.evaluate(() => window.__perf!.snapshot())
    const streamEnded = (await page.getByRole('button', { name: 'Copy answer' }).count()) > 0
    const gpuCompositing = await app.evaluate(({ app: electronApp }) => {
      return String(electronApp.getGPUFeatureStatus().gpu_compositing)
    })
    return {
      scenario: scenario.name,
      durationS,
      probe,
      averages: null,
      samples: [],
      streamEnded,
      gpuCompositing
    }
  } finally {
    await app.close().catch(() => undefined)
    await removeUserDataDir(dir)
  }
}

for (const scenario of selected) {
  test(scenario.name, async () => {
    test.skip(scenario.name !== 'idle', 'not implemented yet')
    test.setTimeout((60 + durationS) * 1000)
    const result = await runFake(scenario)
    await mkdir(resultsDir, { recursive: true })
    const body = JSON.stringify(result, null, 2)
    await writeFile(join(resultsDir, `${scenario.name}.json`), body)
    await test.info().attach('perf-result', { body, contentType: 'application/json' })
  })
}
