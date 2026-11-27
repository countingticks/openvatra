import { execFile } from 'child_process'
import { existsSync } from 'fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { dirname, join, resolve } from 'path'
import { promisify } from 'util'
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { installPerfProbe } from '../../src/shared/perfProbe'
import { settingsSchemaVersion } from '../../src/shared/settings'
import { ggufHeader } from '../e2e/ggufHeader'
import {
  appArgs,
  createUserDataDir,
  removeUserDataDir,
  seedCoreModels,
  waitForCore
} from '../e2e/testProfile'
import { averageOf, modelIdOf } from './math'
import type { Averages, ScenarioResult } from './result'
import { sampleApp, sampleCpu, sampleGpu, type Sampler } from './samplers'
import { longReply, realPrompt, selectScenarios, type Scenario } from './scenarios'

const run = promisify(execFile)

const selected = selectScenarios((process.env.PERF_SCENARIOS ?? '').split(',').filter(Boolean))
const durationS = Number(process.env.PERF_DURATION || '15')
const modelPath = process.env.PERF_MODEL ?? ''
const placement = process.env.PERF_PLACEMENT ?? ''
const trace = process.env.PERF_TRACE === '1'
const resultsDir = resolve('test-results', 'perf')
const answerFile = resolve('tests', 'perf', 'fixtures', 'answer.md')
const bundledLlamaServer = resolve('resources', 'llama', 'bin', 'llama-server.exe')

let workDir: string
let longAnswerFile: string
let fakeServer: string
let modelsDir: string

test.beforeAll(async () => {
  workDir = await mkdtemp(join(tmpdir(), 'openvatra-perf-'))
  fakeServer = join(workDir, 'fake-server.exe')
  await run('go', ['build', '-C', 'core', '-o', fakeServer, './testdata/fake-server'])
  modelsDir = join(workDir, 'models')
  await mkdir(modelsDir)
  await writeFile(join(modelsDir, 'tiny.gguf'), ggufHeader('llama'))
  longAnswerFile = join(workDir, 'answer-long.md')
  await writeFile(longAnswerFile, longReply(await readFile(answerFile, 'utf8')))
})

test.afterAll(async () => {
  if (workDir) await rm(workDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
})

type PageWithApi = { api: { core: { getState(): Promise<{ status: string }> } } }
type CoreModel = { id: string; kind: string; state: string; error?: string }

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** "The answer has started": the conversation grew by at least 20 characters past the user's message. */
async function waitForAnswerStart(
  page: Page,
  sentText: string,
  timeoutMs: number,
  everySecond: () => Promise<void> = async () => {}
): Promise<void> {
  const conversation = page.getByRole('log', { name: 'Conversation' })
  await expect(conversation).toContainText(sentText.slice(0, 40), { timeout: 30_000 })
  const base = (await conversation.innerText()).length
  let lastTick = 0
  let tickError: Error | undefined
  try {
    await expect
      .poll(
        async () => {
          if (Date.now() - lastTick >= 1000) {
            lastTick = Date.now()
            await everySecond().catch((e: Error) => {
              tickError = e
            })
          }
          if (tickError) return Infinity // leave the poll at once; the error is rethrown below
          return (await conversation.innerText()).length
        },
        { timeout: timeoutMs }
      )
      .toBeGreaterThan(base + 19)
  } catch {
    throw tickError ?? new Error(`no answer within ${timeoutMs / 1000} s`)
  }
  if (tickError) throw tickError
}

type AppLoad = Pick<Averages, 'renderer' | 'gpuProcess' | 'browser'>
type GpuLoad = { gpu3d: number; compute: number }

/** One sample per tick index, as long as the shortest series; GPU fields are null when typeperf gave nothing. */
function zipSamples(
  appSeries: AppLoad[],
  cpuSeries: number[],
  gpuSeries: GpuLoad[]
): ScenarioResult['samples'] {
  const length = Math.min(appSeries.length, cpuSeries.length, gpuSeries.length || Infinity)
  return Array.from({ length }, (_, t) => ({
    t: t + 1,
    ...appSeries[t],
    cpu: cpuSeries[t],
    gpu3d: gpuSeries.length ? gpuSeries[t].gpu3d : null,
    compute: gpuSeries.length ? gpuSeries[t].compute : null
  }))
}

async function listModels(port: number, token: string): Promise<CoreModel[]> {
  const response = await fetch(`http://127.0.0.1:${port}/api/models`, {
    headers: { Authorization: `Bearer ${token}` }
  })
  return ((await response.json()) as { models: CoreModel[] }).models
}

/** The last 20 lines of core.log, read through the app while it is still running. */
async function coreLogTail(app: ElectronApplication): Promise<string> {
  try {
    const text = await app.evaluate(({ app: electronApp }) => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { readFileSync } = require('fs') as typeof import('fs')
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { join: joinPath } = require('path') as typeof import('path')
      return readFileSync(joinPath(electronApp.getPath('logs'), 'core.log'), 'utf8')
    })
    return text.trimEnd().split('\n').slice(-20).join('\n')
  } catch {
    return '(core.log could not be read)'
  }
}

async function runScenario(scenario: Scenario): Promise<ScenarioResult> {
  const real = scenario.model === 'real'
  const dir = await createUserDataDir()
  if (scenario.motionOff) {
    await writeFile(
      join(dir, 'settings.json'),
      JSON.stringify({ schemaVersion: settingsSchemaVersion, motion: 'off' })
    )
  }
  const app = await electron.launch({
    args: scenario.disableGpu ? ['--disable-gpu', ...appArgs(dir)] : appArgs(dir),
    // The real scenarios keep the process environment as it is: no FAKE_SERVER_* variables.
    env: real
      ? undefined
      : {
          ...(process.env as Record<string, string>),
          FAKE_SERVER_REPLY_FILE: scenario.reply === 'long' ? longAnswerFile : answerFile,
          FAKE_SERVER_TOKEN_DELAY: scenario.tokenDelay,
          FAKE_SERVER_BURN_CPU: String(scenario.burnCpu)
        }
  })
  let samplers: { app: Sampler<AppLoad>; cpu: Sampler<number>; gpu: Sampler<GpuLoad> } | undefined
  let modelId = 'tiny'
  let shell: { port: number; token: string } | undefined
  try {
    const page = await app.firstWindow()
    if (real) {
      modelId = modelIdOf(modelPath)
      await seedCoreModels(dir, {
        modelsDir: dirname(modelPath),
        lastModel: modelId,
        ...(placement ? { placement: { model: modelId, placement } } : {})
      })
    } else {
      await seedCoreModels(dir, { llamaServerPath: fakeServer, modelsDir, lastModel: modelId })
    }
    shell = await waitForCore(dir)
    await expect
      .poll(
        () =>
          page.evaluate(async () => (await (window as unknown as PageWithApi).api.core.getState()).status),
        { timeout: 20_000 }
      )
      .toBe('ready')
    if (real) {
      const { port, token } = shell
      let found = await listModels(port, token)
      const deadline = Date.now() + 10_000
      while (!found.some((m) => m.id === modelId && m.kind === 'chat')) {
        if (Date.now() > deadline) {
          const ids = found.map((m) => m.id).join(', ') || 'none'
          throw new Error(`${modelId} is not a chat model in ${dirname(modelPath)} (found: ${ids})`)
        }
        await sleep(500)
        found = await listModels(port, token)
      }
    }
    // The chat reads the model list and last model once at start: reload so it sees what was seeded.
    await page.reload()
    await page.getByRole('textbox', { name: 'Message' }).waitFor()
    await page.evaluate(installPerfProbe)

    const sentText = real ? realPrompt : 'Hello'
    const message = page.getByRole('textbox', { name: 'Message' })
    await message.fill(sentText)
    await message.press('Enter')
    try {
      if (scenario.name === 'idle') {
        await expect(page.getByRole('button', { name: 'Copy answer' }).first()).toBeVisible({
          timeout: 30_000
        })
      } else if (real) {
        const { port, token } = shell
        await waitForAnswerStart(page, sentText, 300_000, async () => {
          const model = (await listModels(port, token)).find((m) => m.id === modelId)
          if (model?.state === 'error')
            throw new Error(`model ${modelId} failed: ${model.error ?? 'no detail'}`)
        })
      } else {
        await waitForAnswerStart(page, sentText, 30_000)
      }
    } catch (error) {
      if (!real) throw error
      const detail = (error as Error).message
      const model = (await listModels(shell.port, shell.token).catch(() => [])).find((m) => m.id === modelId)
      const modelError = model?.error && !detail.includes(model.error) ? `\nmodel error: ${model.error}` : ''
      throw new Error(`${detail}${modelError}\ncore.log (last 20 lines):\n${await coreLogTail(app)}`, {
        cause: error
      })
    }
    await sleep(scenario.warmupS * 1000)

    const tracePath = join(resultsDir, `${scenario.name}.trace.json`)
    if (trace) {
      await mkdir(resultsDir, { recursive: true })
      await app.evaluate(async ({ contentTracing }) => {
        await contentTracing.startRecording({
          included_categories: ['toplevel', 'viz', 'gpu', 'cc', 'benchmark']
        })
      })
    }
    await page.evaluate(() => window.__perf?.reset())
    samplers = { app: sampleApp(app), cpu: sampleCpu(), gpu: sampleGpu() }
    await sleep(durationS * 1000)
    const probe = await page.evaluate(() => window.__perf!.snapshot())
    if (trace) {
      await app.evaluate(async ({ contentTracing }, path) => {
        await contentTracing.stopRecording(path)
      }, tracePath)
    }
    const stopped = samplers
    samplers = undefined
    const [appSeries, cpuSeries, gpuSeries] = await Promise.all([
      stopped.app.stop(),
      stopped.cpu.stop(),
      stopped.gpu.stop()
    ])
    const samples = zipSamples(appSeries, cpuSeries, gpuSeries)
    const streamEnded = (await page.getByRole('button', { name: 'Copy answer' }).count()) > 0
    const gpuCompositing = await app.evaluate(({ app: electronApp }) => {
      return String(electronApp.getGPUFeatureStatus().gpu_compositing)
    })
    return {
      scenario: scenario.name,
      durationS,
      probe,
      averages: averageOf(samples),
      samples,
      streamEnded,
      gpuCompositing,
      ...(trace ? { tracePath } : {})
    }
  } finally {
    // A failed scenario must not leave typeperf running.
    if (samplers) await Promise.all([samplers.app.stop(), samplers.cpu.stop(), samplers.gpu.stop()])
    await app.close().catch(() => undefined)
    await removeUserDataDir(dir)
  }
}

/** Why a real-model scenario cannot run, or '' when it can. */
function realSkipReason(): string {
  if (!modelPath) return 'needs --model <gguf path>'
  if (!existsSync(modelPath)) return `${modelPath} not found`
  if (!modelPath.toLowerCase().endsWith('.gguf')) return `${modelPath} is not a .gguf file`
  if (!existsSync(bundledLlamaServer)) return 'run npm run fetch:llama first'
  return ''
}

for (const scenario of selected) {
  test(scenario.name, async () => {
    const real = scenario.model === 'real'
    if (real) test.skip(realSkipReason() !== '', realSkipReason())
    test.setTimeout(((real ? 360 : 60) + durationS) * 1000)
    const result = await runScenario(scenario)
    await mkdir(resultsDir, { recursive: true })
    const body = JSON.stringify(result, null, 2)
    await writeFile(join(resultsDir, `${scenario.name}.json`), body)
    await test.info().attach('perf-result', { body, contentType: 'application/json' })
  })
}
