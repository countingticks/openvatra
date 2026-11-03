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
export function splitArgs(text: string): SplitResult {
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
  const reserved = args.find((arg) => reservedFlags.includes(arg.split('=')[0]))
  if (reserved)
    return { ok: false, error: `${reserved.split('=')[0]} is set by OpenVatra and can't be changed.` }
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
