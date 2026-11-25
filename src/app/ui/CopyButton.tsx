import { useEffect, useState } from 'react'
import { Check, Copy } from 'lucide-react'
import { Button } from '@app/ui/button'

/**
 * Copies `text` (a function is read at click time); its icon turns to Check and its label to "Copied" for 1.5 s.
 * The one copy button: messages, answers and code blocks.
 */
export function CopyButton({
  text,
  label
}: {
  text: string | (() => string)
  label: string
}): React.JSX.Element {
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 1500)
    return () => clearTimeout(timer)
  }, [copied])

  const copy = (): void => {
    navigator.clipboard
      .writeText(typeof text === 'function' ? text() : text)
      .then(() => setCopied(true))
      .catch((error: unknown) => console.error('Could not copy', error))
  }

  return (
    <Button variant="ghost" size="icon-sm" aria-label={copied ? 'Copied' : label} onClick={copy}>
      {copied ? <Check aria-hidden className="size-3.5" /> : <Copy aria-hidden className="size-3.5" />}
    </Button>
  )
}
