import { Plus } from 'lucide-react'
import { useListChatsQuery } from '@app/core/generated'
import { useAppDispatch, useAppSelector } from '@app/store/hooks'
import { navigated, selectRoute } from '@app/store/uiSlice'
import { ChatRow } from './ChatRow'

/** The sidebar's chats, newest first; kept current by registerChatList. */
export function ChatList(): React.JSX.Element {
  const { data, isError } = useListChatsQuery({})
  const route = useAppSelector(selectRoute)
  const dispatch = useAppDispatch()
  const openChat = route.tab === 'chat' ? route.chatId : undefined

  return (
    <section aria-labelledby="chats-heading" className="flex flex-col">
      <div className="flex items-center justify-between pt-[18px] pr-0.5 pb-1.5 pl-2.5">
        <h2 id="chats-heading" className="text-xs font-medium text-muted-foreground">
          Chats
        </h2>
        <button
          type="button"
          aria-label="New chat"
          title="New chat"
          onClick={() => dispatch(navigated({ tab: 'chat' }))}
          className="grid size-6 place-items-center rounded-sm text-muted-foreground outline-none hover:bg-sidebar-accent hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-sidebar-ring"
        >
          <Plus aria-hidden className="size-3.5" />
        </button>
      </div>
      {isError ? (
        <p className="px-2.5 py-1.5 text-[13px] text-muted-foreground">Chats couldn&apos;t be loaded</p>
      ) : data === undefined ? null : data.chats.length === 0 ? (
        <p className="px-2.5 py-1.5 text-[13px] text-muted-foreground">No chats yet</p>
      ) : (
        <ul aria-labelledby="chats-heading" className="flex flex-col gap-0.5">
          {data.chats.map((chat) => (
            <ChatRow key={chat.id} chat={chat} current={chat.id === openChat} />
          ))}
        </ul>
      )}
    </section>
  )
}
