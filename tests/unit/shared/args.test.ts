// @vitest-environment node
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  joinArgs,
  legacyReservedFlags,
  maxArgsLength,
  splitArgs,
  upgradeArgs
} from '../../../src/shared/args'

describe('splitArgs', () => {
  it.each([
    ['', []],
    ['   \n ', []],
    ['-fa on -ctk q8_0', ['-fa', 'on', '-ctk', 'q8_0']],
    ['--jinja\t--temp 1', ['--jinja', '--temp', '1']],
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

  it.each(['-c 131072\n --jinja', '--ctx-size=4096', '-ngl 99', '--cpu-moe', '--fit off'])(
    'refuses a size or placement flag core sets itself: %j',
    (text) => {
      expect(splitArgs(text)).toEqual({ ok: false, error: expect.stringContaining("can't be changed") })
    }
  )

  it('checks against the list it is given', () => {
    expect(splitArgs('-c 8192', legacyReservedFlags)).toEqual({ ok: true, args: ['-c', '8192'] })
  })

  it('refuses text that is too long', () => {
    expect(splitArgs('a'.repeat(maxArgsLength + 1)).ok).toBe(false)
  })
})

describe('joinArgs', () => {
  it('quotes only arguments that need it, so splitArgs reads them back the same', () => {
    const args = ['--temp', '0.7', '--x', 'D:\\My Models\\a.gguf', '']
    const text = joinArgs(args)
    expect(text).toBe('--temp 0.7 --x "D:\\My Models\\a.gguf" ""')
    expect(splitArgs(text)).toEqual({ ok: true, args })
  })

  it('drops quote characters it cannot write', () => {
    expect(joinArgs(['say "hi"'])).toBe('"say hi"')
  })
})

describe('shared fixture with core', () => {
  type Case = { name: string; text: string; args?: string[]; error?: string }
  const path = new URL('../../../core/internal/config/testdata/args.json', import.meta.url)
  const cases = JSON.parse(readFileSync(path, 'utf-8')) as Case[]

  it.each(cases.map((c) => [c.name, c] as const))('%s', (_name, c) => {
    expect(splitArgs(c.text)).toEqual(
      c.error === undefined ? { ok: true, args: c.args } : { ok: false, error: c.error }
    )
  })
})

describe('upgradeArgs, shared fixture with core', () => {
  type Case = {
    name: string
    text: string
    args: string
    context?: number
    placement?: 'gpu' | 'experts' | 'layers'
    dropped: string[]
  }
  const path = new URL('../../../core/internal/config/testdata/upgrade.json', import.meta.url)
  const cases = JSON.parse(readFileSync(path, 'utf-8')) as Case[]

  it.each(cases.map(({ name, ...c }) => [name, c] as const))('%s', (_name, { text, ...want }) => {
    expect(upgradeArgs(text)).toEqual(want)
  })

  it('returns text that does not split as it was', () => {
    expect(upgradeArgs('-c "8192')).toEqual({ args: '-c "8192', dropped: [] })
  })
})
