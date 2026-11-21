import type { ChatItem } from '@app/core/generated'
import { cn } from '@app/lib/utils'
import { useReducedMotion } from '@app/ui/useReducedMotion'
import { useAppDispatch } from '@app/store/hooks'
import { navigated } from '@app/store/uiSlice'

interface ChatRowProps {
  chat: ChatItem
  current: boolean
}

/** One chat in the sidebar: opens it, and shows whether it is answering or was cut off. */
export function ChatRow({ chat, current }: ChatRowProps): React.JSX.Element {
  const dispatch = useAppDispatch()
  const reducedMotion = useReducedMotion()
  const state = chat.activeRun?.state

  return (
    <li>
      <button
        type="button"
        title={chat.title}
        aria-current={current ? 'page' : undefined}
        onClick={() => dispatch(navigated({ tab: 'chat', chatId: chat.id }))}
        className={cn(
          'flex w-full items-center gap-2 rounded-sm px-2.5 py-1.5 text-left text-[13px] outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring',
          current
            ? 'bg-sidebar-accent text-sidebar-accent-foreground'
            : 'text-muted-foreground hover:bg-sidebar-accent/60 hover:text-sidebar-foreground'
        )}
      >
        <span className="min-w-0 flex-1 truncate">{chat.title}</span>
        {/* Keeps "answering" and "cut off" a separate word in the button's name. */}{' '}
        {(state === 'queued' || state === 'running') && (
          <span className="grid size-3 shrink-0 place-items-center">
            <span
              aria-hidden
              className={cn('size-1.5 rounded-full bg-primary', !reducedMotion && 'animate-pulse')}
            />
            <span className="sr-only">answering</span>
          </span>
        )}
        {state === 'interrupted' && (
          <span className="grid size-3 shrink-0 place-items-center">
            <span aria-hidden className="size-1.5 rounded-full border border-muted-foreground" />
            <span className="sr-only">cut off</span>
          </span>
        )}
      </button>
    </li>
  )
}
