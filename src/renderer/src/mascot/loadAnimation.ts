// Finds and parses the frame files. Vite bundles every assets/mascot/*.json at build time (about 200 kB of text),
// so switching states never waits for a file; each is parsed once, on first use.
import { parseAnimation, type Animation, type MascotState } from './animation'

const files = import.meta.glob<unknown>('../assets/mascot/*.json', { eager: true, import: 'default' })
const cache = new Map<MascotState, Animation>()

export function loadAnimation(state: MascotState): Animation {
  const cached = cache.get(state)
  if (cached) return cached

  const json = files[`../assets/mascot/${state}.json`]
  if (json === undefined) throw new Error(`No frame file for mascot state "${state}"`)
  const animation = parseAnimation(json)
  if (animation.state !== state) throw new Error(`${state}.json describes "${animation.state}"`)
  cache.set(state, animation)
  return animation
}
