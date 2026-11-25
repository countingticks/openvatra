import { fullTime, relativeTime } from '@app/ui/relativeTime'
import { useNow } from '@app/ui/useNow'

/** A message's age as <time>, re-rendered each minute; the full date and time in its title. */
export function MessageTime({ time }: { time: number }): React.JSX.Element {
  const now = useNow()
  return (
    <time
      dateTime={new Date(time).toISOString()}
      title={fullTime(time)}
      className="mx-1 text-xs text-muted-foreground tabular-nums"
    >
      {relativeTime(time, now)}
    </time>
  )
}
