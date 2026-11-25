import { cn } from '@app/lib/utils'

/** A message's icon row: invisible until the message is hovered or holds focus, but it keeps its space. */
export function MessageActions({
  className,
  children
}: {
  className?: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div
      className={cn(
        'flex items-center gap-0.5 font-sans opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100 in-data-[motion=reduce]:transition-none',
        className
      )}
    >
      {children}
    </div>
  )
}
