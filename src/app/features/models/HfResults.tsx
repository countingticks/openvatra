import { HfRepoRow } from './HfRepoRow'
import { useSearchHfQuery } from '@app/core/generated'

interface HfResultsProps {
  query: string
}

/** What Hugging Face found for a submitted query. It only exists while a query is submitted, so typing sends nothing. */
export function HfResults({ query }: HfResultsProps): React.JSX.Element {
  const { data, isFetching, isError } = useSearchHfQuery({ q: query })

  if (isFetching) return <Header left="Searching…" />
  if (isError || !data) {
    return (
      <p role="alert" className="text-sm text-destructive">
        Hugging Face couldn&apos;t be reached. Check your connection and press Enter to try again.
      </p>
    )
  }
  const count = data.repos.length
  return (
    <div className="flex flex-col gap-3">
      <Header left={`${count} ${count === 1 ? 'result' : 'results'}`} right="Hugging Face · GGUF only" />
      {count === 0 ? (
        <p className="rounded-lg border border-dashed border-border p-4 text-center text-sm text-muted-foreground">
          No GGUF models match &quot;{query}&quot;.
        </p>
      ) : (
        <ul className="flex flex-col rounded-lg border border-border">
          {data.repos.map((repo) => (
            <HfRepoRow key={repo.id} repo={repo} />
          ))}
        </ul>
      )}
    </div>
  )
}

function Header({ left, right }: { left: string; right?: string }): React.JSX.Element {
  return (
    <div className="flex items-baseline justify-between text-xs text-muted-foreground">
      <h3 className="text-[13px] font-medium text-foreground">{left}</h3>
      {right && <span>{right}</span>}
    </div>
  )
}
