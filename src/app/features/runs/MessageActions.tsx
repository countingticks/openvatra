import { useEffect, useState } from 'react'
import { Check, Copy } from 'lucide-react'
import { cn } from '@app/lib/utils'
import { Button } from '@app/ui/button'

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

/** Copies `text`; its icon turns to Check and its label to "Copied" for 1.5 s. */
export function CopyButton({
  text,
  label
}: {
  text: string
  label: 'Copy answer' | 'Copy message'
}): React.JSX.Element {
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 1500)
    return () => clearTimeout(timer)
  }, [copied])

  const copy = (): void => {
    navigator.clipboard
      .writeText(text)
      .then(() => setCopied(true))
      .catch((error: unknown) => console.error('Could not copy', error))
  }

  return (
    <Button variant="ghost" size="icon-sm" aria-label={copied ? 'Copied' : label} onClick={copy}>
      {copied ? <Check aria-hidden className="size-3.5" /> : <Copy aria-hidden className="size-3.5" />}
    </Button>
  )
}
