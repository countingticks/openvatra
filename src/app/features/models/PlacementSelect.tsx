import { useId } from 'react'
import { Select } from '@base-ui/react/select'
import { Check, ChevronDown } from 'lucide-react'
import type { ModelOptions } from '@app/core/generated'

type Placement = NonNullable<ModelOptions['placement']>

const labels: Record<Placement, string> = {
  auto: 'Auto',
  gpu: 'Whole model on GPU',
  experts: 'Experts in RAM',
  layers: 'Some layers on GPU',
  cpu: 'CPU only'
}

/** For a mixture-of-experts model, layers on the GPU is usually much slower than moving only its experts. */
const moeOrder: Placement[] = ['auto', 'gpu', 'experts', 'cpu', 'layers']
const moeLayersLabel = 'Some layers on GPU (usually much slower for this model)'

interface PlacementSelectProps {
  value: ModelOptions['placement']
  /** A mixture-of-experts model can keep its experts in RAM; others are not offered that. */
  moe: boolean
  /** The chosen placement, or undefined for Auto. */
  onChange: (next: Exclude<ModelOptions['placement'], 'auto'> | undefined) => void
}

/** Where the model runs: Auto lets core pick, the rest are the user's choice. */
export function PlacementSelect({ value, moe, onChange }: PlacementSelectProps): React.JSX.Element {
  const labelId = useId()
  const current = value ?? 'auto'
  const offered = (moe ? moeOrder : (Object.keys(labels) as Placement[])).filter(
    (placement) => placement !== 'experts' || moe || current === 'experts'
  )
  const shown = moe ? { ...labels, layers: moeLayersLabel } : labels

  return (
    <div className="flex flex-col gap-1">
      <span id={labelId} className="text-xs leading-none font-medium">
        Placement
      </span>
      <Select.Root
        value={current}
        items={shown}
        onValueChange={(next) => {
          if (next === 'auto') onChange(undefined)
          else if (typeof next === 'string' && next in labels) onChange(next as Exclude<Placement, 'auto'>)
        }}
      >
        <Select.Trigger
          aria-labelledby={labelId}
          className="flex h-7 w-52 items-center justify-between gap-2 rounded-md border border-input bg-background px-2 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Select.Value />
          <Select.Icon>
            <ChevronDown aria-hidden className="size-3.5 text-muted-foreground" />
          </Select.Icon>
        </Select.Trigger>
        <Select.Portal>
          <Select.Positioner sideOffset={4} className="isolate z-50 outline-none">
            <Select.Popup className="min-w-(--anchor-width) rounded-lg bg-popover p-1 text-xs text-popover-foreground shadow-md ring-1 ring-foreground/10 outline-none">
              {offered.map((placement) => (
                <Select.Item
                  key={placement}
                  value={placement}
                  className="flex cursor-default items-center justify-between gap-2 rounded-md px-2 py-1.5 outline-none data-highlighted:bg-accent"
                >
                  <Select.ItemText>{shown[placement]}</Select.ItemText>
                  <Select.ItemIndicator>
                    <Check aria-hidden className="size-3.5" />
                  </Select.ItemIndicator>
                </Select.Item>
              ))}
            </Select.Popup>
          </Select.Positioner>
        </Select.Portal>
      </Select.Root>
    </div>
  )
}
