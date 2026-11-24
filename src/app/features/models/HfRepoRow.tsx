import { useState } from 'react'
import { ChevronRight, Download, Heart } from 'lucide-react'
import { compactCount, updatedAgo } from './hfText'
import type { Repo } from '@app/core/generated'

interface HfRepoRowProps {
  repo: Repo
}

/** One Hugging Face repo on one line: who and what it is, how popular, how fresh, and a chevron to its files. */
export function HfRepoRow({ repo }: HfRepoRowProps): React.JSX.Element {
  const [open, setOpen] = useState(false)
  // Read once: the age of a result need not tick while the list is open.
  const [now] = useState(() => Date.now())
  return (
    <li className="flex flex-col gap-1 border-b border-border px-3 py-2 last:border-b-0">
      <div className="flex min-h-8 items-center gap-2 text-[13px]">
        <span className="min-w-0 truncate">
          <span className="text-muted-foreground">{repo.owner} / </span>
          <span className="font-medium">{repo.name}</span>
        </span>
        {repo.tags.map((tag) => (
          <span
            key={tag}
            className="shrink-0 rounded-sm bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground"
          >
            {tag}
          </span>
        ))}
        <span className="flex-1" />
        <span
          aria-label={`${compactCount(repo.downloads)} downloads`}
          className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground"
        >
          <Download aria-hidden className="size-3.5" />
          {compactCount(repo.downloads)}
        </span>
        <span
          aria-label={`${compactCount(repo.likes)} likes`}
          className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground"
        >
          <Heart aria-hidden className="size-3.5" />
          {compactCount(repo.likes)}
        </span>
        <span className="w-[84px] shrink-0 text-right text-xs text-muted-foreground">
          {updatedAgo(repo.updatedAt, now)}
        </span>
        <button
          type="button"
          aria-label={`Files in ${repo.owner}/${repo.name}`}
          aria-expanded={open}
          onClick={() => setOpen(!open)}
          className="group flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
        >
          <ChevronRight
            aria-hidden
            className="size-4 transition-transform in-data-[motion=reduce]:transition-none group-aria-expanded:rotate-90"
          />
        </button>
      </div>
    </li>
  )
}
