import { act, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { coreEvent } from '@app/core/events'
import type { Event } from '@app/core/generated'
import { useLiveAnswer } from '@app/features/runs'
import { renderWithStore } from '../../../renderWithStore'

const delta = (text: string, n: number): Event =>
  ({ type: 'message.delta', stream: 'run:r1', v: 1, time: 0, data: { text, n } }) as Event

let renders = 0

function Live(): React.JSX.Element {
  renders++
  const live = useLiveAnswer('r1')
  return <p>live: {live?.text ?? ''}</p>
}

describe('useLiveAnswer', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['requestAnimationFrame', 'cancelAnimationFrame'] })
    renders = 0
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('renders once per frame with every delta of that frame', () => {
    const { store } = renderWithStore(<Live />)
    const before = renders

    act(() => {
      store.dispatch(coreEvent(delta('a', 1)))
      store.dispatch(coreEvent(delta('b', 2)))
      store.dispatch(coreEvent(delta('c', 3)))
    })
    expect(renders).toBe(before)
    act(() => vi.advanceTimersToNextFrame())

    expect(renders).toBe(before + 1)
    expect(screen.getByText('live: abc')).toBeInTheDocument()

    act(() => store.dispatch(coreEvent(delta('d', 4))))
    act(() => vi.advanceTimersToNextFrame())
    expect(screen.getByText('live: abcd')).toBeInTheDocument()
  })
})
