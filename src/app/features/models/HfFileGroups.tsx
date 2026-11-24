import { useEffect } from 'react'
import { HfGroupSlot } from './HfGroupSlot'
import { useSetup } from './useSetup'
import { useListHfFilesQuery } from '@app/core/generated'
import { failureReason, fitLook, fitWords, formatSize } from './modelText'

interface HfFileGroupsProps {
  owner: string
  name: string
  /** Tells the repo's row the tags of the listing (it adds Vision when a quant has a projector). */
  onTags: (tags: string[]) => void
}

/** The quants of one repo with their size, fit and download slot. Mounted only while the repo is open. */
export function HfFileGroups({ owner, name, onTags }: HfFileGroupsProps): React.JSX.Element {
  const { data: listing, error, isLoading } = useListHfFilesQuery({ owner, name })
  const { downloads } = useSetup()

  useEffect(() => {
    if (listing) onTags(listing.tags)
  }, [listing, onTags])

  if (isLoading)
    return (
      <p role="status" className="text-xs text-muted-foreground">
        Loading files…
      </p>
    )
  if (!listing) {
    return (
      <p role="alert" className="text-xs text-destructive">
        {failureReason(error)}
      </p>
    )
  }
  if (listing.groups.length === 0) {
    return <p className="text-xs text-muted-foreground">No GGUF files here.</p>
  }

  return (
    <ul className="flex flex-col rounded-lg bg-card ring-1 ring-border">
      {listing.groups.map((group) => {
        const look = fitLook[group.fit]
        const id = `hf:${listing.repo}:${group.quant}`
        return (
          <li
            key={group.quant}
            className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border px-3 py-1.5 text-xs last:border-b-0"
          >
            <span className="w-[104px] shrink-0 font-mono">{group.quant}</span>
            <span className="w-16 shrink-0 text-muted-foreground">{formatSize(group.sizeBytes)}</span>
            <span className={`flex shrink-0 items-center gap-1 font-medium ${look.colour}`}>
              <look.icon aria-hidden className="size-3.5" />
              {fitWords(group.fit)}
            </span>
            <HfGroupSlot
              repo={listing.repo}
              group={group}
              diskFreeBytes={listing.diskFreeBytes}
              item={downloads.find((download) => download.id === id)}
            />
          </li>
        )
      })}
    </ul>
  )
}
