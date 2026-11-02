// Finds and parses the frame files. Vite bundles every assets/mascot/*.json at build time (about 200 kB of text),
// so switching states never waits for a file; each is parsed once, on first use.
import { parseAnimation, type Animation, type MascotState } from './animation'

const files = import.meta.glob<unknown>('../assets/mascot/*.json', { eager: true, import: 'default' })
const cache = new Map<Clip, Animation>()

/** What Ember can play: a state, or `ready`, loading's burst at 100% that hands over to idle. */
export type Clip = MascotState | 'ready'

export function loadAnimation(clip: Clip): Animation {
  const cached = cache.get(clip)
  if (cached) return cached

  const animation = clip === 'ready' ? readyClip() : parseFile(clip)
  cache.set(clip, animation)
  return animation
}

function parseFile(state: MascotState): Animation {
  const json = files[`../assets/mascot/${state}.json`]
  if (json === undefined) throw new Error(`No frame file for mascot state "${state}"`)
  const animation = parseAnimation(json)
  if (animation.state !== state) throw new Error(`${state}.json describes "${animation.state}"`)
  return animation
}

function readyClip(): Animation {
  const loading = loadAnimation('loading')
  if (!loading.progress?.ready.length) throw new Error('loading.json has no ready-* frames')
  const { ms, palette } = loading
  return { state: 'loading', ms, palette, intro: loading.progress.ready, loop: [], then: 'idle' }
}
