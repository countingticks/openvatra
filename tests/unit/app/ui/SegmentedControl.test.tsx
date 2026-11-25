import { useState } from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { SegmentedControl } from '@app/ui/SegmentedControl'

const options = [
  { value: 'a', label: 'Alpha' },
  { value: 'b', label: 'Beta' }
] as const

function Holder({
  initial,
  onChange = () => {}
}: {
  initial: 'a' | 'b'
  onChange?: (value: 'a' | 'b') => void
}): React.JSX.Element {
  const [value, setValue] = useState<'a' | 'b'>(initial)
  return (
    <>
      <span id="label">Letter</span>
      <SegmentedControl
        labelledBy="label"
        value={value}
        options={options}
        onChange={(next) => {
          setValue(next)
          onChange(next)
        }}
      />
      <button onClick={() => setValue('b')}>From outside</button>
    </>
  )
}

const pill = (container: HTMLElement): Element | null => container.querySelector('[data-pill]')

describe('SegmentedControl', () => {
  it('places the pill at first without sliding', () => {
    const { container } = render(<Holder initial="a" />)

    expect(pill(container)).toBeInTheDocument()
    expect(pill(container)).not.toHaveAttribute('data-slide')
  })

  it('moves the pill without sliding when the value comes from props', () => {
    const { container } = render(<Holder initial="a" />)

    fireEvent.click(screen.getByRole('button', { name: 'From outside' }))

    expect(screen.getByRole('radio', { name: 'Beta' })).toBeChecked()
    expect(pill(container)).not.toHaveAttribute('data-slide')
  })

  it('slides the pill to an option the user picks, and reports it once', () => {
    const onChange = vi.fn()
    const { container } = render(<Holder initial="a" onChange={onChange} />)

    fireEvent.click(screen.getByRole('radio', { name: 'Beta' }))

    expect(pill(container)).toHaveAttribute('data-slide')
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange).toHaveBeenCalledWith('b')
  })
})
