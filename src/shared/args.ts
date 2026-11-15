// llama-server arguments typed as one line, the way llama-swap's config writes them. No shell ever sees the text:
// splitArgs turns it into an argument list that is handed straight to the process. Shared so the settings schema
// (main) and the form (renderer) accept exactly the same text.

/** Flags core sets itself (core/internal/config keeps the same list); typing one would fight core's own. */
export const reservedFlags = [
  '-m',
  '--model',
  '--host',
  '--port',
  '--embedding',
  '--embeddings',
  '-mm',
  '--mmproj'
]

/** The longest argument text a box may hold. */
export const maxArgsLength = 2000

export type SplitResult = { ok: true; args: string[] } | { ok: false; error: string }

/**
 * Spaces (and tabs, line breaks) separate arguments; "…" keeps spaces inside one. Nothing else is special, so
 * Windows paths keep their backslashes: `--x "D:\My Models\a.gguf"` → ['--x', 'D:\My Models\a.gguf'].
 */
export function splitArgs(text: string, reserved: readonly string[] = reservedFlags): SplitResult {
  if (text.length > maxArgsLength) return { ok: false, error: `At most ${maxArgsLength} characters.` }

  const args: string[] = []
  let current = ''
  let inArg = false // tells "" (an empty argument) apart from nothing at all
  let quoted = false
  for (const char of text) {
    if (char === '"') {
      quoted = !quoted
      inArg = true
    } else if (!quoted && /\s/.test(char)) {
      if (inArg) args.push(current)
      current = ''
      inArg = false
    } else {
      current += char
      inArg = true
    }
  }
  if (quoted) return { ok: false, error: 'A quote " is not closed.' }
  if (inArg) args.push(current)

  // "--port=1" counts as --port too.
  const taken = args.find((arg) => reserved.includes(arg.split('=')[0]))
  if (taken) return { ok: false, error: `${taken.split('=')[0]} is set by OpenVatra and can't be changed.` }
  return { ok: true, args }
}

/**
 * The reverse of splitArgs, for turning an argument list into text: quotes only what needs them. A " inside an
 * argument can't be written in this syntax, so it is dropped.
 */
export function joinArgs(args: string[]): string {
  return args
    .map((arg) => arg.replaceAll('"', ''))
    .map((arg) => (arg === '' || /\s/.test(arg) ? `"${arg}"` : arg))
    .join(' ')
}

/** The context sizes a size flag may carry to become a context field (core's llamacpp.MinContext and MaxContext). */
const minContext = 2048
const maxContext = 1048576

export type UpgradedArgs = {
  args: string
  context?: number
  placement?: 'gpu' | 'experts' | 'layers'
  dropped: string[]
}

/** ASCII digits only, no sign, the same as core's upgradeInt. */
const integer = (value: string | undefined): number | undefined =>
  value !== undefined && /^[0-9]+$/.test(value) ? Number(value) : undefined

/**
 * Takes the size and placement flags that became core's own (-c, -ngl, --cpu-moe, --n-cpu-moe, --fit and their
 * aliases) out of argument text written before they were reserved, turning each into the field it means. The TS twin
 * of config.UpgradeArgs in core; both read core/internal/config/testdata/upgrade.json. Text without such a flag, or
 * that doesn't split, comes back as it was.
 */
export function upgradeArgs(text: string): UpgradedArgs {
  const split = splitArgs(text, [])
  if (!split.ok) return { args: text, dropped: [] }
  const words = split.args
  const kept: string[] = []
  const dropped: string[] = []
  let context: number | undefined
  let layers: 'gpu' | 'layers' | undefined
  let experts = false
  let taken = false
  for (let i = 0; i < words.length; i++) {
    const word = words[i]
    const eq = word.indexOf('=')
    const name = eq < 0 ? word : word.slice(0, eq)
    // The flag's value: after = in the same word, else the next word (taken from the text).
    const value = (): { value?: string; flag: string } => {
      if (eq >= 0) return { value: word.slice(eq + 1), flag: word }
      if (i + 1 < words.length) {
        i++
        return { value: words[i], flag: `${word} ${words[i]}` }
      }
      return { flag: word }
    }
    switch (name) {
      case '-c':
      case '--ctx-size': {
        taken = true
        const { value: v, flag } = value()
        const n = integer(v)
        if (n !== undefined && n >= minContext && n <= maxContext) context = n
        else dropped.push(flag)
        break
      }
      case '-cmoe':
      case '--cpu-moe':
        taken = true
        experts = true
        break
      case '-ngl':
      case '--gpu-layers':
      case '--n-gpu-layers': {
        taken = true
        const { value: v, flag } = value()
        const n = integer(v)
        if (v === undefined) dropped.push(flag)
        else if (v === 'all' || (n !== undefined && n >= 99)) layers = 'gpu'
        else if (v === 'auto') layers = undefined
        else if (n !== undefined)
          layers = 'layers' // core picks the number itself
        else dropped.push(flag)
        break
      }
      case '-ncmoe':
      case '--n-cpu-moe':
        taken = true
        dropped.push(value().flag)
        break
      case '-fit':
      case '--fit': {
        taken = true
        let flag = word
        if (eq < 0 && (words[i + 1] === 'on' || words[i + 1] === 'off')) {
          i++
          flag += ` ${words[i]}`
        }
        dropped.push(flag)
        break
      }
      default:
        kept.push(word)
    }
  }
  if (!taken) return { args: text, dropped: [] }
  const placement = experts ? 'experts' : layers
  return {
    args: joinArgs(kept),
    ...(context !== undefined && { context }),
    ...(placement !== undefined && { placement }),
    dropped
  }
}
