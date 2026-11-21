import type { SnippetPart } from '@app/core/generated'

/** A search hit's text with the matched words marked. Rendered as text, never as HTML. */
export function Snippet({ parts }: { parts: SnippetPart[] }): React.JSX.Element {
  return (
    <>
      {parts.map((part, i) =>
        part.match ? (
          <mark key={i} className="rounded-xs bg-primary/20 text-foreground">
            {part.text}
          </mark>
        ) : (
          <span key={i}>{part.text}</span>
        )
      )}
    </>
  )
}
