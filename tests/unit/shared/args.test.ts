// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { joinArgs, maxArgsLength, splitArgs } from '../../../src/shared/args'

describe('splitArgs', () => {
  it.each([
    ['', []],
    ['   \n ', []],
    ['-fa on -ctk q8_0', ['-fa', 'on', '-ctk', 'q8_0']],
    ['-c 131072\n  --jinja\t-ngl 99', ['-c', '131072', '--jinja', '-ngl', '99']],
    ['--x "D:\\My Models\\a.gguf"', ['--x', 'D:\\My Models\\a.gguf']],
    ['--alias="my model" next', ['--alias=my model', 'next']],
    ['--chat-template ""', ['--chat-template', '']]
  ])('splits %j', (text, args) => {
    expect(splitArgs(text)).toEqual({ ok: true, args })
  })

  it('refuses an unclosed quote', () => {
    expect(splitArgs('--alias "my model')).toEqual({ ok: false, error: expect.stringContaining('quote') })
  })

  it.each(['--port 9000', '-m x.gguf', '--model=x.gguf', '--mmproj p.gguf', '--embeddings'])(
    'refuses a flag core sets itself: %s',
    (text) => {
      expect(splitArgs(text)).toEqual({ ok: false, error: expect.stringContaining("can't be changed") })
    }
  )

  it('refuses text that is too long', () => {
    expect(splitArgs('a'.repeat(maxArgsLength + 1)).ok).toBe(false)
  })
})

describe('joinArgs', () => {
  it('quotes only arguments that need it, so splitArgs reads them back the same', () => {
    const args = ['-c', '4096', '--x', 'D:\\My Models\\a.gguf', '']
    const text = joinArgs(args)
    expect(text).toBe('-c 4096 --x "D:\\My Models\\a.gguf" ""')
    expect(splitArgs(text)).toEqual({ ok: true, args })
  })

  it('drops quote characters it cannot write', () => {
    expect(joinArgs(['say "hi"'])).toBe('"say hi"')
  })
})
