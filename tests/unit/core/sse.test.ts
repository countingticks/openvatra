import { describe, expect, it } from 'vitest'
import { takeFrames, type SseFrame } from '@renderer/core/sse'

/** Feeds chunks in order the way the stream reader does, collecting every frame. */
function readChunks(chunks: string[]): { frames: SseFrame[]; rest: string } {
  const frames: SseFrame[] = []
  let buffer = ''
  for (const chunk of chunks) {
    const taken = takeFrames(buffer + chunk)
    frames.push(...taken.frames)
    buffer = taken.rest
  }
  return { frames, rest: buffer }
}

describe('takeFrames', () => {
  it('reads two frames from one chunk', () => {
    const { frames, rest } = takeFrames('event: hello\ndata: {"a":1}\n\ndata: {"b":2}\n\n')

    expect(frames).toEqual([
      { event: 'hello', id: null, data: '{"a":1}' },
      { event: 'message', id: null, data: '{"b":2}' }
    ])
    expect(rest).toBe('')
  })

  it('puts a frame split over three chunks back together', () => {
    const { frames, rest } = readChunks(['da', 'ta: {"type":"mod', 'el.state"}\n\n'])

    expect(frames).toEqual([{ event: 'message', id: null, data: '{"type":"model.state"}' }])
    expect(rest).toBe('')
  })

  it('reads \\r\\n line ends, even when a chunk ends between \\r and \\n', () => {
    const { frames } = readChunks(['event: hello\r\ndata: x\r', '\n\r\ndata: y\r\n\r\n'])

    expect(frames).toEqual([
      { event: 'hello', id: null, data: 'x' },
      { event: 'message', id: null, data: 'y' }
    ])
  })

  it('produces nothing for a comment line or a keepalive frame', () => {
    const { frames, rest } = takeFrames(': keepalive\n\nid: 4\n\n')

    expect(frames).toEqual([])
    expect(rest).toBe('')
  })

  it('reads the id and joins two data lines', () => {
    const { frames } = takeFrames('id: 135\ndata: first\ndata:second\n\n')

    expect(frames).toEqual([{ event: 'message', id: '135', data: 'first\nsecond' }])
  })

  it('keeps an unfinished frame as the rest', () => {
    const { frames, rest } = takeFrames('data: done\n\ndata: half')

    expect(frames).toEqual([{ event: 'message', id: null, data: 'done' }])
    expect(rest).toBe('data: half')
  })
})
