import { useId } from 'react'
import { Dropdown, type DropdownOption } from '@app/ui/Dropdown'
import type { ModelOptions } from '@app/core/generated'

type Placement = NonNullable<ModelOptions['placement']>

/** In the order the list shows them. */
const placements: DropdownOption<Placement>[] = [
  { value: 'auto', label: 'Automatic', hint: 'Picks what fits best' },
  { value: 'gpu', label: 'All on the graphics card', hint: 'Fastest, needs the most memory' },
  { value: 'experts', label: 'Experts on the CPU', hint: "For MoE models that don't fit" },
  { value: 'layers', label: 'Some layers on the GPU', hint: 'Part of the model on the graphics card' },
  { value: 'cpu', label: 'CPU only', hint: 'Slowest, frees the graphics card' }
]

interface PlacementSelectProps {
  value: ModelOptions['placement']
  /** A mixture-of-experts model can keep its experts on the CPU; other models are offered layers instead. */
  moe: boolean
  /** The chosen placement, or undefined for Auto. */
  onChange: (next: Exclude<ModelOptions['placement'], 'auto'> | undefined) => void
}

/** Where the model runs: Automatic lets core pick, the rest are the user's choice. */
export function PlacementSelect({ value, moe, onChange }: PlacementSelectProps): React.JSX.Element {
  const labelId = useId()
  const current = value ?? 'auto'
  // What is stored stays on offer even when the model would not normally get it.
  const offered = placements.filter((option) => {
    if (option.value === 'experts') return moe || current === 'experts'
    if (option.value === 'layers') return !moe || current === 'layers'
    return true
  })

  return (
    <div className="flex flex-col gap-1">
      <span id={labelId} className="text-xs leading-none font-medium">
        Placement
      </span>
      <Dropdown
        labelledBy={labelId}
        value={current}
        options={offered}
        onChange={(next) => onChange(next === 'auto' ? undefined : next)}
      />
    </div>
  )
}
