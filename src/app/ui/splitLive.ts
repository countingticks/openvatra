interface Fence {
  char: string
  length: number
}

const openRe = /^ {0,3}(`{3,}|~{3,})(.*)$/
const blankRe = /^[ \t]*$/
const listItemRe = /^([-*+]|\d{1,9}[.)])([ \t]|$)/

/** The fence a line opens, or undefined. */
function opensFence(line: string): Fence | undefined {
  const match = openRe.exec(line)
  if (!match) return undefined
  if (match[1][0] === '`' && match[2].includes('`')) return undefined
  return { char: match[1][0], length: match[1].length }
}

function closesFence(line: string, fence: Fence): boolean {
  // Neither fence character is special in a regex.
  return new RegExp(`^ {0,3}${fence.char}{${fence.length},}[ \\t]*$`).test(line)
}

/** The fence state after a line: unchanged unless the line opens or closes one. */
function step(line: string, fence: Fence | undefined): Fence | undefined {
  if (fence) return closesFence(line, fence) ? undefined : fence
  return opensFence(line)
}

const withoutCr = (line: string): string => (line.endsWith('\r') ? line.slice(0, -1) : line)

/** True when a fence opened in `text` has no closing fence after it. */
export function endsInOpenFence(text: string): boolean {
  let fence: Fence | undefined
  for (const raw of text.split('\n')) fence = step(withoutCr(raw), fence)
  return fence !== undefined
}

/**
 * The text cut at every safe break: before a complete, non-indented paragraph-start line that follows a blank line,
 * outside a fence, and that is not a list item or table row (those can continue a loose list or a table).
 * `chunks.join('')` is `text`, and growing the text never changes a finished chunk.
 */
export function splitLive(text: string): string[] {
  if (text === '') return []
  const lines = text.split('\n')
  const chunks: string[] = []
  let fence: Fence | undefined
  let start = 0
  let offset = 0
  let previousBlank = false
  for (let i = 0; i < lines.length; i++) {
    const line = withoutCr(lines[i])
    const complete = i < lines.length - 1
    const blank = blankRe.test(line)
    if (
      i > 0 &&
      !fence &&
      previousBlank &&
      !blank &&
      complete &&
      !/^[ \t]/.test(line) &&
      !listItemRe.test(line) &&
      !line.startsWith('|')
    ) {
      chunks.push(text.slice(start, offset))
      start = offset
    }
    fence = step(line, fence)
    previousBlank = blank
    offset += lines[i].length + 1
  }
  chunks.push(text.slice(start))
  return chunks
}
