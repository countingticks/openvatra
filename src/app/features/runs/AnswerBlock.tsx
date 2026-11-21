import type { ReactNode } from 'react'
import { Markdown } from '@app/ui/Markdown'
import { ThinkingDisclosure } from './ThinkingDisclosure'

/** One answer as the reader sees it: its thinking (when there was some), its text, and what goes under it. */
export function AnswerBlock({
  text,
  reasoning,
  thinkingLabel,
  children
}: {
  text: string
  reasoning: string
  thinkingLabel: string
  children?: ReactNode
}): React.JSX.Element {
  return (
    <div className="group font-serif text-[17px] leading-[1.65]">
      {reasoning !== '' && <ThinkingDisclosure label={thinkingLabel} reasoning={reasoning} />}
      {text !== '' && <Markdown text={text} />}
      {children}
    </div>
  )
}
