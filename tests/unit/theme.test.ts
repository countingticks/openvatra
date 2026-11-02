import { afterEach, describe, expect, it, vi } from 'vitest'
import { followColorScheme } from '@renderer/theme'

/** A controllable prefers-color-scheme: tests flip it like Windows (or Settings → Theme) would. */
function fakeColorScheme(dark: boolean): { set(dark: boolean): void } {
  const listeners = new Set<() => void>()
  const media = {
    matches: dark,
    addEventListener: (_: string, listener: () => void) => listeners.add(listener),
    removeEventListener: (_: string, listener: () => void) => listeners.delete(listener)
  }
  vi.stubGlobal('matchMedia', (query: string) => {
    expect(query).toBe('(prefers-color-scheme: dark)')
    return media
  })
  return {
    set(value) {
      media.matches = value
      listeners.forEach((listener) => listener())
    }
  }
}

afterEach(() => {
  document.documentElement.classList.remove('dark')
})

describe('followColorScheme', () => {
  it('applies dark at once when the scheme is dark', () => {
    fakeColorScheme(true)

    followColorScheme()

    expect(document.documentElement).toHaveClass('dark')
  })

  it('stays light when the scheme is light', () => {
    fakeColorScheme(false)

    followColorScheme()

    expect(document.documentElement).not.toHaveClass('dark')
  })

  it('follows changes live, both ways', () => {
    const scheme = fakeColorScheme(false)
    followColorScheme()

    scheme.set(true)
    expect(document.documentElement).toHaveClass('dark')

    scheme.set(false)
    expect(document.documentElement).not.toHaveClass('dark')
  })

  it('stops following once told to', () => {
    const scheme = fakeColorScheme(false)
    const stop = followColorScheme()

    stop()
    scheme.set(true)

    expect(document.documentElement).not.toHaveClass('dark')
  })
})
