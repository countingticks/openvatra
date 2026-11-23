import { useEffect, useId, useRef, useState } from 'react'
import { Plus, Search } from 'lucide-react'
import { useListChatsQuery } from '@app/core/generated'
import { useAppDispatch, useAppSelector } from '@app/store/hooks'
import { navigated, selectRoute } from '@app/store/uiSlice'
import { usePlatform } from '@app/platform/usePlatform'
import { ChatGroupHeader } from './ChatGroupHeader'
import { chatGroupIds, groupChats, type ChatGroupId } from './chatGroups'
import { ChatRow } from './ChatRow'
import { useLocalDay } from './useLocalDay'

const searchDelayMs = 200
const foldedKey = 'chat.groups.folded'
const iconButton =
  'grid size-6 place-items-center rounded-sm text-muted-foreground outline-none hover:bg-sidebar-accent hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-sidebar-ring'

function loadFolded(raw: string | null): ChatGroupId[] {
  try {
    const value: unknown = raw === null ? [] : JSON.parse(raw)
    return Array.isArray(value) ? chatGroupIds.filter((id) => value.includes(id)) : []
  } catch {
    return []
  }
}

/** The sidebar's chats, newest first (kept current by registerChatList), or the hits of a search. */
export function ChatList(): React.JSX.Element {
  const [searching, setSearching] = useState(false)
  const [typed, setTyped] = useState('')
  // The query core is asked: the typed text, once typing paused.
  const [query, setQuery] = useState('')
  const { storage } = usePlatform()
  const [folded, setFolded] = useState(() => loadFolded(storage.get(foldedKey)))
  const now = useLocalDay()
  const listId = useId()
  const searchButton = useRef<HTMLButtonElement>(null)
  const field = useRef<HTMLInputElement>(null)
  const q = query.trim()
  const all = useListChatsQuery({})
  const hits = useListChatsQuery({ q }, { skip: q === '' })
  const { data, isError } = q === '' ? all : hits
  const route = useAppSelector(selectRoute)
  const dispatch = useAppDispatch()
  const openChat = route.tab === 'chat' ? route.chatId : undefined

  useEffect(() => {
    const timer = setTimeout(() => setQuery(typed), searchDelayMs)
    return () => clearTimeout(timer)
  }, [typed])

  useEffect(() => {
    if (searching) field.current?.focus()
  }, [searching])

  function toggleSearch(): void {
    setSearching(!searching)
    setTyped('')
    setQuery('')
    searchButton.current?.focus()
  }

  function toggleGroup(id: ChatGroupId): void {
    const next = chatGroupIds.filter((g) => (g === id ? !folded.includes(g) : folded.includes(g)))
    setFolded(next)
    storage.set(foldedKey, next.length === 0 ? null : JSON.stringify(next))
  }

  return (
    <section aria-labelledby="chats-heading" className="flex flex-col">
      <div className="flex items-center justify-between pt-[18px] pr-0.5 pb-1.5 pl-2.5">
        <h2 id="chats-heading" className="text-xs font-medium text-muted-foreground">
          Chats
        </h2>
        <div className="flex items-center gap-0.5">
          <button
            ref={searchButton}
            type="button"
            aria-label="Search chats"
            title="Search chats"
            aria-expanded={searching}
            onClick={toggleSearch}
            className={iconButton}
          >
            <Search aria-hidden className="size-3.5" />
          </button>
          <button
            type="button"
            aria-label="New chat"
            title="New chat"
            onClick={() => dispatch(navigated({ tab: 'chat' }))}
            className={iconButton}
          >
            <Plus aria-hidden className="size-3.5" />
          </button>
        </div>
      </div>
      {searching && (
        <input
          ref={field}
          type="text"
          aria-label="Search chats"
          placeholder="Search chats"
          value={typed}
          onChange={(event) => setTyped(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== 'Escape') return
            event.preventDefault()
            event.stopPropagation()
            toggleSearch()
          }}
          className="mx-2 mb-1.5 rounded-sm bg-background px-2.5 py-1.5 text-[13px] text-foreground ring-1 ring-sidebar-border outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring"
        />
      )}
      {isError ? (
        <p className="px-2.5 py-1.5 text-[13px] text-muted-foreground">Chats couldn&apos;t be loaded</p>
      ) : data === undefined ? null : data.chats.length === 0 ? (
        <p className="px-2.5 py-1.5 text-[13px] text-muted-foreground">
          {q === '' ? 'No chats yet' : 'No chats found'}
        </p>
      ) : (
        <ul aria-labelledby="chats-heading" className="flex flex-col gap-0.5">
          {q !== ''
            ? data.chats.map((chat) => (
                <ChatRow key={chat.id} chat={chat} current={chat.id === openChat} snippet={chat.snippet} />
              ))
            : groupChats(data.chats, now).map((group) => {
                const isFolded = folded.includes(group.id)
                const rows = isFolded ? group.chats.filter((chat) => chat.id === openChat) : group.chats
                const innerId = `${listId}-${group.id}`
                return (
                  <li key={group.id}>
                    <ChatGroupHeader
                      label={group.label}
                      folded={isFolded}
                      controls={rows.length > 0 ? innerId : undefined}
                      onToggle={() => toggleGroup(group.id)}
                    />
                    {rows.length > 0 && (
                      <ul id={innerId} aria-label={group.label} className="flex flex-col gap-0.5">
                        {rows.map((chat) => (
                          <ChatRow key={chat.id} chat={chat} current={chat.id === openChat} />
                        ))}
                      </ul>
                    )}
                  </li>
                )
              })}
        </ul>
      )}
    </section>
  )
}
