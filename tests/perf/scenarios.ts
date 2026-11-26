import type { ScenarioName } from './result'

export interface Scenario {
  name: ScenarioName
  isolates: string // the "Isolates" column of the spec's table, for the report
  model: 'fake' | 'real'
  tokenDelay: string // FAKE_SERVER_TOKEN_DELAY; '0' for idle, '20ms' for stream*
  burnCpu: number // FAKE_SERVER_BURN_CPU
  disableGpu: boolean
  motionOff: boolean
}

export const scenarios: readonly Scenario[] = [
  {
    name: 'idle',
    isolates: 'the app at rest: backdrop and compositing only',
    model: 'fake',
    tokenDelay: '0',
    burnCpu: 0,
    disableGpu: false,
    motionOff: false
  },
  {
    name: 'stream',
    isolates: 'rendering a streamed markdown answer',
    model: 'fake',
    tokenDelay: '20ms',
    burnCpu: 0,
    disableGpu: false,
    motionOff: false
  },
  {
    name: 'stream-cpu',
    isolates: 'streaming while the machine is busy (CPU contention)',
    model: 'fake',
    tokenDelay: '20ms',
    burnCpu: -1,
    disableGpu: false,
    motionOff: false
  },
  {
    name: 'stream-nogpu',
    isolates: 'streaming under load with software compositing',
    model: 'fake',
    tokenDelay: '20ms',
    burnCpu: -1,
    disableGpu: true,
    motionOff: false
  },
  {
    name: 'stream-still',
    isolates: 'streaming with motion off (no backdrop animation)',
    model: 'fake',
    tokenDelay: '20ms',
    burnCpu: 0,
    disableGpu: false,
    motionOff: true
  },
  {
    name: 'real',
    isolates: 'a real model streaming (GPU and CPU shared with llama-server)',
    model: 'real',
    tokenDelay: '0',
    burnCpu: 0,
    disableGpu: false,
    motionOff: false
  },
  {
    name: 'real-nogpu',
    isolates: 'a real model with software compositing',
    model: 'real',
    tokenDelay: '0',
    burnCpu: 0,
    disableGpu: true,
    motionOff: false
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
