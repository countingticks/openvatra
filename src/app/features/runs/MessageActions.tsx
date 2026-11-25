import { cn } from '@app/lib/utils'

/** A message's icon row, always visible so nothing shifts when the pointer enters the message. */
export function MessageActions({
  className,
  children
}: {
  className?: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className={cn('flex items-center gap-0.5 font-sans text-muted-foreground', className)}>
      {children}
    </div>
  )
}
