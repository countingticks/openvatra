import { ChevronDown } from 'lucide-react'
import { cn } from '@app/lib/utils'
import { useReducedMotion } from '@app/ui/useReducedMotion'

/** A group's fold button: chevron and label. */
export function ChatGroupHeader({
  label,
  folded,
  controls,
  onToggle
}: {
  label: string
  folded: boolean
  /** id of the group's inner list while it is drawn; left out when it is not. */
  controls?: string
  onToggle(): void
}): React.JSX.Element {
  const reducedMotion = useReducedMotion()
  return (
    <button
      type="button"
      aria-expanded={!folded}
      aria-controls={controls}
      onClick={onToggle}
      className="mt-2.5 flex h-[26px] w-full items-center gap-1 rounded-sm pr-2.5 pl-1.5 text-left text-xs font-medium text-muted-foreground outline-none hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-sidebar-ring"
    >
      <ChevronDown
        aria-hidden
        className={cn(
          'size-3 shrink-0',
          !reducedMotion && 'transition-transform duration-[160ms]',
          folded && '-rotate-90'
        )}
      />
      {label}
    </button>
  )
}
