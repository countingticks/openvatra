import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useLocalDay } from '@app/features/chat/useLocalDay'

afterEach(() => vi.useRealTimers())

describe('useLocalDay', () => {
  it('changes only when local midnight passes, and again the next midnight', () => {
    vi.useFakeTimers()
    const start = new Date(2026, 10, 18, 23, 59).getTime()
    vi.setSystemTime(start)
    const { result } = renderHook(() => useLocalDay())
    expect(result.current).toBe(start)

    act(() => vi.advanceTimersByTime(59_000))
    expect(result.current).toBe(start)

    act(() => vi.advanceTimersByTime(1000))
    expect(result.current).toBe(new Date(2026, 10, 19).getTime())

    act(() => vi.advanceTimersByTime(24 * 3_600_000))
    expect(result.current).toBe(new Date(2026, 10, 20).getTime())
  })

  it('leaves no timer behind once unmounted', () => {
    vi.useFakeTimers()
    const { unmount } = renderHook(() => useLocalDay())
    unmount()
    expect(vi.getTimerCount()).toBe(0)
  })
})
