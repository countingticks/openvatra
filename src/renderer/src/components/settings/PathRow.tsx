import { useId } from 'react'
import { Button } from '@renderer/components/ui/button'
import { cn } from '@renderer/lib/utils'

interface PathRowProps {
  label: string
  hint: string
  /** null until chosen. */
  path: string | null
  /** Shown instead of "Not chosen" when `path` is null, for a default that works without a choice. */
  defaultText?: string
  /** The Browse button's text; its accessible name stays "Browse for <label>". */
  browseText?: string
  onBrowse: () => void
  /** Extra buttons beside Browse. */
  children?: React.ReactNode
}

/** A path the user picks with Windows' own dialog (main opens it); the path itself is shown, never typed. */
export function PathRow({
  label,
  hint,
  path,
  defaultText = 'Not chosen',
  browseText = 'Browse…',
  onBrowse,
  children
}: PathRowProps): React.JSX.Element {
  const pathId = useId()

  return (
    <div className="flex items-center justify-between gap-5 border-b border-border py-4">
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="text-sm font-medium">{label}</span>
        <p className="text-[12.5px] text-muted-foreground">{hint}</p>
        <p
          id={pathId}
          className={cn(
            'pt-1 text-xs',
            path ? 'font-mono break-all select-text' : 'text-muted-foreground italic'
          )}
        >
          {path ?? defaultText}
        </p>
      </div>
      <div className="flex shrink-0 gap-2">
        {children}
        <Button
          variant="outline"
          size="sm"
          aria-label={`Browse for ${label}`}
          aria-describedby={pathId}
          onClick={onBrowse}
        >
          {browseText}
        </Button>
      </div>
    </div>
  )
}
