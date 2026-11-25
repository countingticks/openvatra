import { useEffect, useRef, useState } from 'react'
import { HfRepoRow } from './HfRepoRow'
import { resultRange } from './hfText'
import { failureReason } from './modelText'
import { useSearchHfQuery } from '@app/core/generated'

interface HfResultsProps {
  query: string
}

const pagerButton =
  'rounded-md px-2 py-1 text-[13px] outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50'

/**
 * What Hugging Face found for the settled query, ten repos a page. It only exists once the pause after typing (or
 * Enter) has set a query, and the parent keys it by query so a new one starts on page 0. It reads currentData, so
 * the answer to an earlier query or page never shows under the new one.
 */
export function HfResults({ query }: HfResultsProps): React.JSX.Element {
  const [page, setPage] = useState(0)
  const { currentData: data, isError, error } = useSearchHfQuery({ q: query, page })
  const heading = useRef<HTMLHeadingElement>(null)
  // Focus moves to the header only after a page turn, never on the first answer.
  const turned = useRef(false)

  useEffect(() => {
    if (!data || !turned.current) return
    turned.current = false
    heading.current?.focus()
  }, [data])

  function turn(to: number): void {
    turned.current = true
    setPage(to)
  }

  if (isError) {
    const busy = typeof error === 'object' && 'status' in error && error.status === 429
    return (
      <p role="alert" className="text-sm text-destructive">
        {busy
          ? failureReason(error)
          : "Hugging Face couldn't be reached. Check your connection and press Enter to try again."}
      </p>
    )
  }
  if (!data) return <Header left="Searching…" />
  const count = data.repos.length
  const left = count > 0 ? resultRange(page, count) : page === 0 ? '0 results' : 'No more results'
  return (
    <div className="flex flex-col gap-3">
      <Header ref={heading} left={left} right="Hugging Face · GGUF only" />
      {count === 0 ? (
        page === 0 && (
          <p className="rounded-lg border border-dashed border-border p-4 text-center text-sm text-muted-foreground">
            No GGUF models match &quot;{query}&quot;.
          </p>
        )
      ) : (
        <ul className="flex flex-col rounded-lg border border-border">
          {data.repos.map((repo) => (
            <HfRepoRow key={repo.id} repo={repo} />
          ))}
        </ul>
      )}
      {(page > 0 || data.hasMore) && (
        <nav aria-label="Result pages" className="flex items-center justify-center gap-3">
          <button type="button" disabled={page === 0} onClick={() => turn(page - 1)} className={pagerButton}>
            ‹ Previous
          </button>
          <span className="text-xs text-muted-foreground">Page {page + 1}</span>
          <button
            type="button"
            disabled={!data.hasMore}
            onClick={() => turn(page + 1)}
            className={pagerButton}
          >
            Next ›
          </button>
        </nav>
      )}
    </div>
  )
}

function Header({
  left,
  right,
  ref
}: {
  left: string
  right?: string
  ref?: React.Ref<HTMLHeadingElement>
}): React.JSX.Element {
  return (
    <div className="flex items-baseline justify-between text-xs text-muted-foreground">
      <h3 ref={ref} tabIndex={-1} className="text-[13px] font-medium text-foreground outline-none">
        {left}
      </h3>
      {right && <span>{right}</span>}
    </div>
  )
}
