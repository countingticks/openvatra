import { useLayoutEffect, useRef, useState } from 'react'
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
  const groupRef = useRef<HTMLDivElement>(null)
  // Where the raised pill sits: under the checked option. It slides there instead of jumping.
  const [pill, setPill] = useState<{ left: number; width: number }>()

  useLayoutEffect(() => {
    const group = groupRef.current
    if (!group) return
    function place(): void {
      const checked = group?.querySelector<HTMLElement>('[role="radio"][data-checked]')
      if (checked) setPill({ left: checked.offsetLeft, width: checked.offsetWidth })
    }
    place()
    // Fonts loading or a text-size change moves the options without the value changing.
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(place)
    observer.observe(group)
    return () => observer.disconnect()
  }, [value, options])

  return (
    <RadioGroup
      ref={groupRef}
      aria-labelledby={labelledBy}
      value={value}
      // Base UI reports the new value as unknown; only accept one of ours.
      onValueChange={(next) => {
        const option = options.find((candidate) => candidate.value === next)
        if (option) onChange(option.value)
      }}
      className="relative inline-flex shrink-0 gap-0.5 rounded-lg border border-border bg-sidebar p-[3px]"
    >
      {pill && (
        <span
          aria-hidden
          style={{ width: pill.width, transform: `translateX(${pill.left}px)` }}
          className="absolute top-[3px] bottom-[3px] left-0 rounded-md bg-card shadow-sm transition-[transform,width] duration-200 ease-out in-data-[motion=reduce]:transition-none dark:bg-accent"
        />
      )}
      {options.map((option) => (
        <Radio.Root
          key={option.value}
          value={option.value}
          className="relative inline-flex h-7 items-center justify-center rounded-md px-3 text-[13px] whitespace-nowrap text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring data-checked:font-medium data-checked:text-foreground"
        >
          {/* Trimmed to cap height and baseline, so centring lines up the letters you see. Geist leaves more room
              below the baseline than above the capitals, which otherwise put the labels ~1.3px high. */}
          <span className="[text-box:trim-both_cap_alphabetic]">{option.label}</span>
        </Radio.Root>
      ))}
    </RadioGroup>
  )
}
