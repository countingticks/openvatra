import { readFileSync } from 'fs'
import { describe, expect, it } from 'vitest'
import { endsInOpenFence, splitLive } from '@app/ui/splitLive'

const fixture = readFileSync('tests/perf/fixtures/answer.md', 'utf8')

describe('splitLive', () => {
  it('cuts after each blank-line run, keeping the blank lines with the earlier chunk', () => {
    expect(splitLive('a\n\nb\n\nc\n')).toEqual(['a\n\n', 'b\n\n', 'c\n'])
  })

  it.each([
    ['a ``` fence', 'a\n\n```\nx\n\ny\n```\n'],
    ['a ~~~~ fence', 'a\n\n~~~~\nx\n\ny\n~~~~\n']
  ])('does not cut inside %s', (_name, text) => {
    expect(splitLive(text)).toEqual(['a\n\n', text.slice(3)])
  })

  it('an indented ``` inside a fence does not close it', () => {
    const text = 'a\n\n```\nx\n    ```\n\ny\n```\n\nafter\n'
    expect(splitLive(text)).toEqual(['a\n\n', '```\nx\n    ```\n\ny\n```\n\n', 'after\n'])
  })

  it.each([
    ['a numbered loose list', '1. a\n\n2. b\n'],
    ['a bullet loose list', '- a\n\n- b\n'],
    ['a table row', 'a\n\n| a | b |\n'],
    ['an indented line', 'a\n\n    code\n'],
    ['a thematic break', 'a\n\n- - -\n']
  ])('does not cut before %s', (_name, text) => {
    expect(splitLive(text)).toEqual([text])
  })

  it('does not cut before a paragraph until its line is complete', () => {
    expect(splitLive('a\n\nb')).toEqual(['a\n\nb'])
    expect(splitLive('a\n\nb\n')).toEqual(['a\n\n', 'b\n'])
  })

  it('gives [] for empty text and [text] for one paragraph', () => {
    expect(splitLive('')).toEqual([])
    expect(splitLive('one paragraph\nstill one')).toEqual(['one paragraph\nstill one'])
  })

  it('cuts once for a run of blank lines', () => {
    expect(splitLive('a\n\n\nb\n')).toEqual(['a\n\n\n', 'b\n'])
  })

  it('treats \\r\\n line ends like \\n', () => {
    const lf = 'a\n\n```\nx\n\ny\n```\n\nb\n'
    const crlf = lf.replaceAll('\n', '\r\n')
    expect(splitLive(crlf)).toEqual(splitLive(lf).map((chunk) => chunk.replaceAll('\n', '\r\n')))
  })

  it('joins back to the text when cut at every 50th character', () => {
    for (let n = 0; n <= fixture.length; n += 50) {
      const text = fixture.slice(0, n)
      expect(splitLive(text).join('')).toBe(text)
    }
  })

  it('never changes a finished chunk as the text grows', () => {
    const whole = splitLive(fixture)
    for (let n = 0; n <= fixture.length; n += 50) {
      const chunks = splitLive(fixture.slice(0, n))
      const finished = chunks.slice(0, -1)
      expect(finished).toEqual(whole.slice(0, finished.length))
    }
  })
})

describe('endsInOpenFence', () => {
  it.each([
    ['```ts\nconst a', true],
    ['```ts\na\n```\n', false],
    ['~~~\na\n```\n', true],
    ['no fence', false]
  ])('%j is %s', (text, expected) => {
    expect(endsInOpenFence(text)).toBe(expected)
  })
})
