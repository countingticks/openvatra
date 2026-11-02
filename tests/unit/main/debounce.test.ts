// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { debounce } from '../../../src/main/debounce'

// Fake timers: the test moves the clock itself, so waiting 500 ms takes no real time.
beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('debounce', () => {
  it('runs once, after the calls stop, with the last arguments', () => {
    const fn = vi.fn()
    const debounced = debounce(fn, 500)

    debounced(1)
    vi.advanceTimersByTime(300)
    debounced(2)
    vi.advanceTimersByTime(300)
    debounced(3)
    expect(fn).not.toHaveBeenCalled()

    vi.advanceTimersByTime(500)
    expect(fn).toHaveBeenCalledExactlyOnceWith(3)
  })

  it('flush runs a waiting call now, and only once', () => {
    const fn = vi.fn()
    const debounced = debounce(fn, 500)

    debounced('a')
    debounced.flush()
    expect(fn).toHaveBeenCalledExactlyOnceWith('a')

    vi.advanceTimersByTime(500)
    expect(fn).toHaveBeenCalledOnce()
  })

  it('flush does nothing when no call is waiting', () => {
    const fn = vi.fn()
    debounce(fn, 500).flush()
    expect(fn).not.toHaveBeenCalled()
  })

  it('cancel drops a waiting call', () => {
    const fn = vi.fn()
    const debounced = debounce(fn, 500)

    debounced()
    debounced.cancel()
    vi.advanceTimersByTime(500)
    expect(fn).not.toHaveBeenCalled()
  })
})
