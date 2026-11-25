import type { ReactNode } from 'react'
import { Markdown } from '@app/ui/Markdown'
import { ThinkingDisclosure } from './ThinkingDisclosure'

/** One answer as the reader sees it: its thinking (when there was some), its text, and what goes under it. */
export function AnswerBlock({
  text,
  reasoning,
  thinkingLabel,
  quotable = false,
  children
}: {
  text: string
  reasoning: string
  thinkingLabel: string
  /** The text can be quoted from a selection (a finished answer; the live one cannot). */
  quotable?: boolean
  children?: ReactNode
}): React.JSX.Element {
  return (
    <div className="group font-serif text-[17px] leading-[1.65]">
      {reasoning !== '' && <ThinkingDisclosure label={thinkingLabel} reasoning={reasoning} />}
      {text !== '' &&
        (quotable ? (
          <div data-quote>
            <Markdown text={text} />
          </div>
        ) : (
          <Markdown text={text} />
        ))}
      {children}
    </div>
  )
}
