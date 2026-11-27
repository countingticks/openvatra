import type { ScenarioName } from './result'

export interface Scenario {
  name: ScenarioName
  isolates: string // the "Isolates" column of the spec's table, for the report
  model: 'fake' | 'real'
  tokenDelay: string // FAKE_SERVER_TOKEN_DELAY; '0' for idle, '20ms' for stream*
  burnCpu: number // FAKE_SERVER_BURN_CPU
  disableGpu: boolean
  motionOff: boolean
  reply: 'answer' | 'long' // which fixture the fake server streams
  warmupS: number // seconds between the answer starting and the measured window
}

export const scenarios: readonly Scenario[] = [
  {
    name: 'idle',
    isolates: 'Backdrop and Ember alone',
    model: 'fake',
    tokenDelay: '0',
    burnCpu: 0,
    disableGpu: false,
    motionOff: false,
    reply: 'answer',
    warmupS: 2
  },
  {
    name: 'stream',
    isolates: 'Renderer cost (suspect 1)',
    model: 'fake',
    tokenDelay: '20ms',
    burnCpu: 0,
    disableGpu: false,
    motionOff: false,
    reply: 'answer',
    warmupS: 2
  },
  {
    name: 'stream-cpu',
    isolates: 'CPU contention (suspect 2)',
    model: 'fake',
    tokenDelay: '20ms',
    burnCpu: -1,
    disableGpu: false,
    motionOff: false,
    reply: 'answer',
    warmupS: 2
  },
  {
    name: 'stream-nogpu',
    isolates: 'Whether software compositing helps',
    model: 'fake',
    tokenDelay: '20ms',
    burnCpu: -1,
    disableGpu: true,
    motionOff: false,
    reply: 'answer',
    warmupS: 2
  },
  {
    name: 'stream-still',
    isolates: 'Renderer cost without backdrop and Ember',
    model: 'fake',
    tokenDelay: '20ms',
    burnCpu: 0,
    disableGpu: false,
    motionOff: true,
    reply: 'answer',
    warmupS: 2
  },
  {
    name: 'stream-long',
    isolates: 'Renderer cost late in a long answer (suspect 1)',
    model: 'fake',
    tokenDelay: '1ms',
    burnCpu: 0,
    disableGpu: false,
    motionOff: false,
    reply: 'long',
    warmupS: 10
  },
  {
    name: 'real',
    isolates: 'All suspects, as the owner sees it',
    model: 'real',
    tokenDelay: '0',
    burnCpu: 0,
    disableGpu: false,
    motionOff: false,
    reply: 'answer',
    warmupS: 2
  },
  {
    name: 'real-nogpu',
    isolates: 'GPU contention (suspect 3)',
    model: 'real',
    tokenDelay: '0',
    burnCpu: 0,
    disableGpu: true,
    motionOff: false,
    reply: 'answer',
    warmupS: 2
  }
]

/** Empty names = the whole list. Throws `unknown scenario "<x>"; one of: <names>` for a name not in the list. */
export function selectScenarios(names: string[]): Scenario[] {
  const known = scenarios.map((s) => s.name)
  for (const name of names) {
    if (!known.includes(name as ScenarioName)) {
      throw new Error(`unknown scenario "${name}"; one of: ${known.join(', ')}`)
    }
  }
  return names.length === 0 ? [...scenarios] : scenarios.filter((s) => names.includes(s.name))
}

/** What the real-model scenarios send: asks for a long, markdown-heavy answer to stream for the whole window. */
export const realPrompt =
  'Write a detailed guide of about 1,500 words on keeping a small web service fast and reliable. ' +
  'Use several headings, a numbered list of steps with sub-points, a table comparing at least five techniques ' +
  '(columns: technique, benefit, cost), and two short code blocks, one in TypeScript and one in Go. ' +
  'Do not stop early and do not ask questions; write the whole guide.'

/** The answer fixture repeated 20 times, so the window measures a long answer. */
export function longReply(text: string): string {
  return Array<string>(20).fill(text).join('\n\n')
}
