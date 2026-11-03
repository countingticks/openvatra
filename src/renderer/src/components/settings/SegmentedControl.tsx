import { Radio } from '@base-ui/react/radio'
import { RadioGroup } from '@base-ui/react/radio-group'

interface SegmentedControlProps<T extends string> {
  /** Id of the visible label, so the group is announced by name. */
  labelledBy: string
  value: T
  options: readonly { value: T; label: string }[]
  onChange: (value: T) => void
}

/**
 * Choose one of a few options, shown as a pill track with the chosen option raised (design decision). Underneath
 * it's a radio group: screen readers announce it as one, and the arrow keys move between options.
 */
export function SegmentedControl<T extends string>({
  labelledBy,
  value,
  options,
  onChange
}: SegmentedControlProps<T>): React.JSX.Element {
  return (
    <RadioGroup
      aria-labelledby={labelledBy}
      value={value}
      // Base UI reports the new value as unknown; only accept one of ours.
      onValueChange={(next) => {
        const option = options.find((candidate) => candidate.value === next)
        if (option) onChange(option.value)
      }}
      className="inline-flex shrink-0 gap-0.5 rounded-lg border border-border bg-sidebar p-[3px]"
    >
      {options.map((option) => (
        <Radio.Root
          key={option.value}
          value={option.value}
          className="inline-flex h-7 items-center justify-center rounded-md px-3 text-[13px] whitespace-nowrap text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring data-checked:bg-card data-checked:font-medium data-checked:text-foreground data-checked:shadow-sm dark:data-checked:bg-accent"
        >
          {/* Trimmed to cap height and baseline, so centring lines up the letters you see. Geist leaves more room
              below the baseline than above the capitals, which otherwise put the labels ~1.3px high. */}
          <span className="[text-box:trim-both_cap_alphabetic]">{option.label}</span>
        </Radio.Root>
      ))}
    </RadioGroup>
  )
}
