// Reads server-sent events out of a streamed fetch body. Kept apart from main's reader on purpose: the window and
// main never share code across the process boundary.

export interface SseFrame {
  event: string
  id: string | null
  data: string
}

function parseFrame(block: string): SseFrame | null {
  let event = 'message' // the SSE default when no "event:" line is given
  let id: string | null = null
  const data: string[] = []
  for (const line of block.split('\n')) {
    if (line.startsWith(':')) continue // a comment, such as core's keepalive
    const colon = line.indexOf(':')
    const field = colon === -1 ? line : line.slice(0, colon)
    const value = colon === -1 ? '' : line.slice(colon + 1).replace(/^ /, '')
    if (field === 'event') event = value
    else if (field === 'id') id = value
    else if (field === 'data') data.push(value)
  }
  // A frame without data dispatches nothing (SSE rule); core's keepalives look like this.
  return data.length === 0 ? null : { event, id, data: data.join('\n') }
}

/** Cuts complete frames off the front of buffer; the unfinished tail comes back as rest. */
export function takeFrames(buffer: string): { frames: SseFrame[]; rest: string } {
  // A chunk may end between the \r and \n of one line end; keep that \r back so it is not read as two line ends.
  const heldBack = buffer.endsWith('\r') ? '\r' : ''
  const text = (heldBack ? buffer.slice(0, -1) : buffer).replace(/\r\n?/g, '\n')
  const blocks = text.split('\n\n')
  const rest = (blocks.pop() ?? '') + heldBack
  const frames = blocks.map(parseFrame).filter((frame): frame is SseFrame => frame !== null)
  return { frames, rest }
}
