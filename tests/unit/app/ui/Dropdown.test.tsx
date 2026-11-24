import { useState } from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { Dropdown, type DropdownOption } from '@app/ui/Dropdown'

type Pick = 'a' | 'b' | 'c'
const options: DropdownOption<Pick>[] = [
  { value: 'a', label: 'Alpha', hint: 'The first one' },
  { value: 'b', label: 'Beta', hint: 'The second one' },
  { value: 'c', label: 'Gamma', hint: 'The third one' }
]

function Harness({
  onChange,
  onParentKeyDown
}: {
  onChange: (value: Pick) => void
  onParentKeyDown?: () => void
}): React.JSX.Element {
  const [value, setValue] = useState<Pick>('b')
  return (
    // The wrapper stands in for the Settings dialog, which closes on Escape.
    <div role="presentation" onKeyDown={onParentKeyDown}>
      <span id="pick-label">Pick</span>
      <Dropdown
        labelledBy="pick-label"
        value={value}
        options={options}
        onChange={(next) => {
          setValue(next)
          onChange(next)
        }}
      />
    </div>
  )
}

describe('Dropdown', () => {
  it('is a combobox named by its label and shows the chosen label', () => {
    render(<Harness onChange={vi.fn()} />)

    expect(screen.getByRole('combobox', { name: 'Pick' })).toHaveTextContent('Beta')
  })

  it('lists every option with its hint, marks the chosen one and draws no checkmark', async () => {
    render(<Harness onChange={vi.fn()} />)

    fireEvent.click(screen.getByRole('combobox', { name: 'Pick' }))

    const listed = await screen.findAllByRole('option')
    expect(listed.map((option) => option.textContent)).toEqual([
      'AlphaThe first one',
      'BetaThe second one',
      'GammaThe third one'
    ])
    expect(screen.getByRole('option', { name: 'Beta' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('option', { name: 'Alpha' })).toHaveAttribute('aria-selected', 'false')
    expect(screen.getByRole('option', { name: 'Beta' })).toHaveAccessibleDescription('The second one')
    expect(screen.getByRole('listbox').querySelector('svg')).toBeNull()
  })

  it('ArrowDown then Enter picks the next option once; Escape closes without a change', async () => {
    const onChange = vi.fn()
    render(<Harness onChange={onChange} />)
    const trigger = screen.getByRole('combobox', { name: 'Pick' })

    fireEvent.click(trigger)
    await screen.findByRole('listbox')
    await vi.waitFor(() => expect(screen.getByRole('listbox').contains(document.activeElement)).toBe(true))
    fireEvent.keyDown(document.activeElement as Element, { key: 'ArrowDown' })
    fireEvent.keyDown(document.activeElement as Element, { key: 'Enter' })

    expect(onChange).toHaveBeenCalledExactlyOnceWith('c')
    await vi.waitFor(() => expect(screen.queryByRole('listbox')).toBeNull())

    fireEvent.click(trigger)
    fireEvent.keyDown(await screen.findByRole('listbox'), { key: 'Escape' })

    await vi.waitFor(() => expect(screen.queryByRole('listbox')).toBeNull())
    expect(onChange).toHaveBeenCalledTimes(1)
  })

  it('keeps Escape from reaching a parent listener', async () => {
    const onParentKeyDown = vi.fn()
    render(<Harness onChange={vi.fn()} onParentKeyDown={onParentKeyDown} />)

    fireEvent.click(screen.getByRole('combobox', { name: 'Pick' }))
    fireEvent.keyDown(await screen.findByRole('listbox'), { key: 'Escape' })

    expect(onParentKeyDown).not.toHaveBeenCalled()
  })
})
