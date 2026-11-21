import { formatTokens } from './formatTokens'

/** How full the chat's context is ("3.1k / 32k context"); nothing while the size is unknown (a new chat, a removed model). */
export function ContextMeter({ used, size }: { used: number; size: number }): React.JSX.Element | null {
  if (size === 0) return null
  return (
    <span
      aria-label={`${used} of ${size} tokens of context used`}
      className="text-xs text-muted-foreground tabular-nums"
    >
      {formatTokens(used)} / {formatTokens(size)} context
    </span>
  )
}
