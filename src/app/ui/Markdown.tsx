import { memo, useRef, type ComponentProps, type ReactElement, type ReactNode } from 'react'
import ReactMarkdown, { type Components, type Options } from 'react-markdown'
import rehypeHighlight from 'rehype-highlight'
import remarkGfm from 'remark-gfm'
import { CopyButton } from '@app/ui/CopyButton'
import { endsInOpenFence, splitLive } from '@app/ui/splitLive'

// Only http(s) leaves the app (main enforces the same); anything else is shown as plain text.
const isWebUrl = (url: string | undefined): url is string => !!url && /^https?:\/\//i.test(url)

/** Language name from the `language-xyz` class that react-markdown puts on a fenced block's <code>. */
function languageOf(children: ReactNode): string {
  const code = children as ReactElement<{ className?: string }> | undefined
  return /language-([\w-]+)/.exec(code?.props?.className ?? '')?.[1] ?? 'text'
}

function CodeBlock({ children }: ComponentProps<'pre'>): React.JSX.Element {
  const pre = useRef<HTMLPreElement>(null)
  return (
    <div className="my-3 overflow-hidden rounded-lg border bg-muted/50">
      <div className="flex items-center justify-between border-b px-3 py-1 font-sans text-xs text-muted-foreground">
        <span>{languageOf(children)}</span>
        {/* Read the text from the DOM: the highlighted code is many nested spans, the DOM already joins them. */}
        <CopyButton text={() => pre.current?.textContent ?? ''} label="Copy code" />
      </div>
      <pre ref={pre} className="overflow-x-auto p-3 font-mono text-[13px] leading-relaxed">
        {children}
      </pre>
    </div>
  )
}

const linkClass = 'text-primary underline underline-offset-2'

const components: Components = {
  pre: CodeBlock,
  // Inline code only: fenced blocks get their <code> styling from CodeBlock's <pre>.
  code: ({ className, children }) =>
    className ? (
      <code className={className}>{children}</code>
    ) : (
      <code className="rounded bg-muted px-1 py-0.5 font-mono text-[0.9em]">{children}</code>
    ),
  a: ({ href, children }) =>
    isWebUrl(href) ? (
      // target=_blank is what makes main's window-open handler send it to the default browser.
      <a href={href} target="_blank" rel="noreferrer" className={linkClass}>
        {children}
      </a>
    ) : (
      <span>{children}</span>
    ),
  // Remote images are never loaded (CSP, and a tracking-pixel risk): show a link to them instead.
  img: ({ src, alt }) => {
    const url = typeof src === 'string' ? src : undefined
    return isWebUrl(url) ? (
      <a href={url} target="_blank" rel="noreferrer" className={linkClass}>
        {alt || url}
      </a>
    ) : (
      <span>{alt || url}</span>
    )
  },
  p: ({ children }) => <p className="my-3 first:mt-0 last:mb-0">{children}</p>,
  h1: ({ children }) => <h1 className="mt-5 mb-2 text-xl font-semibold">{children}</h1>,
  h2: ({ children }) => <h2 className="mt-5 mb-2 text-lg font-semibold">{children}</h2>,
  h3: ({ children }) => <h3 className="mt-4 mb-1 font-semibold">{children}</h3>,
  h4: ({ children }) => <h4 className="mt-4 mb-1 font-semibold">{children}</h4>,
  ul: ({ children }) => <ul className="my-3 list-disc pl-6">{children}</ul>,
  ol: ({ children }) => <ol className="my-3 list-decimal pl-6">{children}</ol>,
  li: ({ children }) => <li className="my-1">{children}</li>,
  blockquote: ({ children }) => (
    <blockquote className="my-3 border-l-2 pl-3 text-muted-foreground">{children}</blockquote>
  ),
  hr: () => <hr className="my-5" />,
  table: ({ children }) => (
    <div className="my-3 overflow-x-auto">
      <table className="w-full border-collapse text-left">{children}</table>
    </div>
  ),
  th: ({ children }) => <th className="border-b px-3 py-1.5 font-semibold">{children}</th>,
  td: ({ children }) => <td className="border-b px-3 py-1.5">{children}</td>
}

// Module-level so the arrays aren't new objects on every streamed word.
const remarkPlugins = [remarkGfm]
// Raw HTML is deliberately not enabled (no rehype-raw): react-markdown then shows `<script>` as plain text.
const rehypePlugins = [rehypeHighlight]
// Stable identity so a memoized chunk with an open fence still skips re-renders.
const noPlugins: NonNullable<Options['rehypePlugins']> = []

// The parsed output of recent finished answers. Parsing a long answer takes hundreds of milliseconds; the output is
// a pure function of the text (plugins and components never change), so reopening a chat reuses it.
const parsedLimit = 32
const parsed = new Map<string, ReactElement>()

function parsedAnswer(text: string): ReactElement {
  const hit = parsed.get(text)
  if (hit) {
    // Most recently used goes last, so the oldest is first to go.
    parsed.delete(text)
    parsed.set(text, hit)
    return hit
  }
  // react-markdown's sync Markdown is a plain function (no hooks), so its element tree can be kept and reused.
  const element = ReactMarkdown({ children: text, remarkPlugins, rehypePlugins, components })
  parsed.set(text, element)
  if (parsed.size > parsedLimit) parsed.delete(parsed.keys().next().value as string)
  return element
}

/** One live chunk: finished chunks keep their props, so memo skips them. */
const Chunk = memo(function Chunk({
  text,
  highlight
}: {
  text: string
  highlight: boolean
}): React.JSX.Element {
  return (
    <ReactMarkdown
      remarkPlugins={remarkPlugins}
      rehypePlugins={highlight ? rehypePlugins : noPlugins}
      components={components}
    >
      {text}
    </ReactMarkdown>
  )
})

/**
 * Renders an answer's markdown. Untrusted model text in, safe React elements out; typography is the caller's.
 * `live` is for a growing answer: it is cut at safe breaks so only the last chunk re-parses, and a code fence
 * is highlighted once it closes.
 */
// Memoized: a finished answer re-parses only when its text changes, not when the chat around it re-renders.
export const Markdown = memo(function Markdown({
  text,
  live = false
}: {
  text: string
  live?: boolean
}): React.JSX.Element {
  if (!live) {
    return <div className="break-words">{parsedAnswer(text)}</div>
  }
  const chunks = splitLive(text)
  const last = chunks.length - 1
  return (
    <div className="break-words">
      {chunks.map((chunk, i) => (
        <Chunk key={i} text={chunk} highlight={!(i === last && endsInOpenFence(chunk))} />
      ))}
    </div>
  )
})
