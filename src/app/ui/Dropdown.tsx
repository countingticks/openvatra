import { useId } from 'react'
import { Select } from '@base-ui/react/select'
import { ChevronDown } from 'lucide-react'
import { cn } from '@app/lib/utils'

export interface DropdownOption<T extends string> {
  value: T
  label: string
  hint?: string
}

export interface DropdownProps<T extends string> {
  value: T
  options: readonly DropdownOption<T>[]
  onChange: (value: T) => void
  /** id of the visible label; the button is a combobox named by it */
  labelledBy: string
  className?: string
}

function DropdownItem<T extends string>({
  option,
  selected
}: {
  option: DropdownOption<T>
  selected: boolean
}): React.JSX.Element {
  const labelId = useId()
  const hintId = useId()
  return (
    <Select.Item
      value={option.value}
      aria-labelledby={labelId}
      aria-describedby={option.hint ? hintId : undefined}
      className={cn(
        'flex cursor-default flex-col gap-0.5 rounded-md px-2.5 py-1.5 outline-none data-highlighted:bg-accent/60',
        selected && 'bg-accent font-medium'
      )}
    >
      <Select.ItemText>
        <span id={labelId} className="text-[13px]">
          {option.label}
        </span>
      </Select.ItemText>
      {option.hint && (
        <span id={hintId} className="text-[11.5px] font-normal text-muted-foreground">
          {option.hint}
        </span>
      )}
    </Select.Item>
  )
}

/**
 * Choose one of a few options that need a sentence each. Base UI's Select underneath, so the keys are its own
 * (arrows, Enter, Esc, Tab closes). The chosen option is marked by its background, not a checkmark.
 */
export function Dropdown<T extends string>({
  value,
  options,
  onChange,
  labelledBy,
  className
}: DropdownProps<T>): React.JSX.Element {
  return (
    <Select.Root
      value={value}
      items={options.map(({ value: itemValue, label }) => ({ value: itemValue, label }))}
      onValueChange={(next) => {
        const option = options.find((candidate) => candidate.value === next)
        if (option) onChange(option.value)
      }}
    >
      <Select.Trigger
        aria-labelledby={labelledBy}
        className={cn(
          'group flex h-8 min-w-0 items-center justify-between gap-2 rounded-md border border-input bg-background px-2.5 text-[13px] outline-none focus-visible:ring-2 focus-visible:ring-ring',
          className
        )}
      >
        <Select.Value className="truncate" />
        <Select.Icon>
          <ChevronDown
            aria-hidden
            className="size-3.5 text-muted-foreground transition-transform group-data-popup-open:rotate-180 in-data-[motion=reduce]:transition-none"
          />
        </Select.Icon>
      </Select.Trigger>
      <Select.Portal>
        <Select.Positioner sideOffset={4} className="isolate z-50 outline-none">
          <Select.Popup
            // Escape closes the list only; the Settings dialog behind it stays.
            onKeyDown={(event) => {
              if (event.key === 'Escape') event.stopPropagation()
            }}
            className="w-[260px] min-w-(--anchor-width) rounded-[10px] bg-popover p-1 text-popover-foreground shadow-md ring-1 ring-foreground/10 outline-none"
          >
            {options.map((option) => (
              <DropdownItem key={option.value} option={option} selected={option.value === value} />
            ))}
          </Select.Popup>
        </Select.Positioner>
      </Select.Portal>
    </Select.Root>
  )
}
