import { useEffect, useRef, useState } from 'react'
import { Search } from 'lucide-react'
import { HfResults } from './HfResults'
import { SuggestedRow } from './SuggestedRow'
import { useSetup } from './useSetup'
import { formatSize } from './modelText'

const minQuery = 2
const maxQuery = 100
const debounceMs = 400

/**
 * The models we suggest, and a search of Hugging Face that runs 400 ms after the last key, or at once on Enter.
 * Its own component so the catalog is read only while its tab is open; the search and the open results are local
 * and reset with it.
 */
export function GetMoreModels(): React.JSX.Element {
  const { catalog, downloads } = useSetup()
  const [text, setText] = useState('')
  const [query, setQuery] = useState('')
  // Enter again remounts the results: a failed search is asked again, an answered one comes from the cache.
  const [attempt, setAttempt] = useState(0)

  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  function stopTimer(): void {
    clearTimeout(timer.current)
    timer.current = undefined
  }
  useEffect(() => stopTimer, [])

  function change(next: string): void {
    setText(next)
    stopTimer()
    const trimmed = next.trim()
    if (trimmed === '') {
      setQuery('')
    } else if (trimmed.length >= minQuery && trimmed.length <= maxQuery) {
      timer.current = setTimeout(() => setQuery(trimmed), debounceMs)
    }
  }

  function submit(event: React.FormEvent): void {
    event.preventDefault()
    const trimmed = text.trim()
    if (trimmed.length < minQuery || trimmed.length > maxQuery) return
    stopTimer()
    setQuery(trimmed)
    setAttempt((count) => count + 1)
  }

  return (
    <div className="flex flex-col gap-3">
      <form
        role="search"
        aria-label="Search Hugging Face"
        onSubmit={submit}
        className="flex flex-col gap-1.5"
      >
        <div className="relative">
          <Search
            aria-hidden
            className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
          />
          <input
            type="search"
            aria-label="Search Hugging Face"
            placeholder="Search Hugging Face, e.g. qwen coder"
            value={text}
            maxLength={maxQuery * 2}
            onChange={(event) => change(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== 'Escape' || query === '') return
              // Settings would close on Escape; here it only closes the results.
              event.stopPropagation()
              event.preventDefault()
              stopTimer()
              setText('')
              setQuery('')
            }}
            className="h-9 w-full rounded-lg border border-input bg-background pr-3 pl-9 text-[13px] outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
          />
        </div>
        <p className="text-xs text-muted-foreground">
          Your search goes to huggingface.co. Nothing else leaves your PC.
        </p>
      </form>

      {query !== '' ? (
        <HfResults key={`${attempt}:${query}`} query={query} />
      ) : !catalog ? (
        <p role="status">Loading the list…</p>
      ) : (
        <>
          {catalog.diskFreeBytes !== null && (
            <p className="text-xs text-muted-foreground">
              {formatSize(catalog.diskFreeBytes)} free where models are saved.
            </p>
          )}
          <div className="flex items-baseline justify-between text-xs text-muted-foreground">
            <h3 className="text-[13px] font-medium text-foreground">Suggested</h3>
            <span>Picked to fit this PC</span>
          </div>
          <ul className="flex flex-col rounded-lg border border-border">
            {catalog.entries.map((entry) => (
              <SuggestedRow
                key={entry.id}
                entry={entry}
                recommended={entry.id === catalog.recommended}
                item={downloads.find((download) => download.id === entry.id)}
              />
            ))}
          </ul>
        </>
      )}
    </div>
  )
}
