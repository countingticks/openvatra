import { Popover, PopoverContent, PopoverTrigger } from '@app/ui/popover'
import { formatTokens } from './formatTokens'
import { contextRows, type ContextRow } from './contextRows'
import { cn } from '@app/lib/utils'
import type { ContextUse } from '@app/core/generated'

/** The mascot's colours, the same in both themes; Free is drawn with the theme's own tokens. */
const swatch: Record<Exclude<ContextRow['key'], 'free'>, string> = {
  system: '#7A2418',
  messages: '#B8402A',
  search: '#EE8A1E',
  files: '#F0B64A'
}

function Swatch({ row, className }: { row: ContextRow; className: string }): React.JSX.Element {
  return row.key === 'free' ? (
    <span aria-hidden className={cn(className, 'bg-accent ring-1 ring-border-strong')} />
  ) : (
    <span aria-hidden className={className} style={{ background: swatch[row.key] }} />
  )
}

/** A 14 px ring: the share of the context in use, in brand on an accent track. */
function Gauge({ share }: { share: number }): React.JSX.Element {
  const radius = 5.5
  const circumference = 2 * Math.PI * radius
  return (
    <svg aria-hidden viewBox="0 0 14 14" className="size-3.5 -rotate-90">
      <circle cx="7" cy="7" r={radius} fill="none" strokeWidth="2" className="stroke-accent" />
      <circle
        cx="7"
        cy="7"
        r={radius}
        fill="none"
        strokeWidth="2"
        strokeLinecap="round"
        strokeDasharray={`${share * circumference} ${circumference}`}
        className="stroke-brand"
      />
    </svg>
  )
}

/** The context button and its popover; nothing while the size is 0 (a new chat, a removed model). */
export function ContextPopover({ context }: { context: ContextUse | null }): React.JSX.Element | null {
  if (context === null || context.size === 0) return null
  const { used, size } = context
  const rows = contextRows(context)
  const whole = Math.max(size, used)

  return (
    <Popover>
      <PopoverTrigger
        aria-label={`Context: ${used.toLocaleString('en-US')} of ${size.toLocaleString('en-US')} tokens used. Show details`}
        aria-haspopup="dialog"
        className="flex h-7 items-center gap-2 rounded-sm px-2 text-xs font-medium text-muted-foreground tabular-nums outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring data-popup-open:bg-accent data-popup-open:text-foreground"
      >
        <Gauge share={Math.min(used / size, 1)} />
        {formatTokens(used)} / {formatTokens(size)}
      </PopoverTrigger>
      <PopoverContent side="top" align="end" aria-label="Context usage" className="w-[300px]">
        <h2 className="text-[13px] font-medium">Context</h2>
        <div aria-hidden className="flex h-2 overflow-hidden rounded-full bg-accent">
          {rows.map((row) => (
            <span
              key={row.key}
              className={cn('h-full', row.key === 'free' && 'bg-accent')}
              style={{
                width: `${(row.tokens / whole) * 100}%`,
                ...(row.key === 'free' ? {} : { background: swatch[row.key] })
              }}
            />
          ))}
        </div>
        <ul className="flex flex-col gap-1.5 text-xs">
          {rows.map((row) => (
            <li key={row.key} className="flex items-center gap-2">
              <Swatch row={row} className="size-[9px] shrink-0 rounded-[3px]" />
              <span className="flex-1">{row.label}</span>
              <span className="text-muted-foreground tabular-nums">{row.tokens.toLocaleString('en-US')}</span>
            </li>
          ))}
        </ul>
      </PopoverContent>
    </Popover>
  )
}
