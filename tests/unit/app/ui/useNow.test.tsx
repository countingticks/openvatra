import { act, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useNow } from '@app/ui/useNow'

function Clock({ label }: { label: string }): React.JSX.Element {
  return <p aria-label={label}>{useNow()}</p>
}

describe('useNow', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(1_800_000_000_000)
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('shares one interval, ticks each minute and stops when nobody uses it', () => {
    const first = render(<Clock label="a" />)
    const second = render(<Clock label="b" />)
    expect(screen.getByLabelText('a').textContent).toBe('1800000000000')
    expect(screen.getByLabelText('b').textContent).toBe('1800000000000')
    expect(vi.getTimerCount()).toBe(1)

    act(() => {
      vi.advanceTimersByTime(60_000)
    })
    expect(screen.getByLabelText('a').textContent).toBe('1800000060000')
    expect(screen.getByLabelText('b').textContent).toBe('1800000060000')

    first.unmount()
    second.unmount()
    expect(vi.getTimerCount()).toBe(0)
  })
})
