import { Fragment, useEffect, useRef, useState } from 'react'
import { Download, MoreHorizontal, PenLine, Trash2, type LucideIcon } from 'lucide-react'
import {
  useDeleteChatMutation,
  useUpdateChatMutation,
  type ChatItem,
  type SnippetPart
} from '@app/core/generated'
import { cn } from '@app/lib/utils'
import { usePlatform } from '@app/platform/usePlatform'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger
} from '@app/ui/context-menu'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@app/ui/dropdown-menu'
import { useReducedMotion } from '@app/ui/useReducedMotion'
import { useAppDispatch } from '@app/store/hooks'
import { navigated } from '@app/store/uiSlice'
import { DeleteChatDialog } from './DeleteChatDialog'
import { Snippet } from './Snippet'

interface ChatRowProps {
  chat: ChatItem
  current: boolean
  /** Where a search matched this chat's messages. */
  snippet?: SnippetPart[]
}

interface Action {
  label: string
  icon: LucideIcon
  run(): void
  destructive?: boolean
}

/** One chat in the sidebar: opens it, shows whether it is answering or was cut off, and holds its actions. */
export function ChatRow({ chat, current, snippet }: ChatRowProps): React.JSX.Element {
  const dispatch = useAppDispatch()
  const platform = usePlatform()
  const reducedMotion = useReducedMotion()
  const [updateChat] = useUpdateChatMutation()
  const [deleteChat] = useDeleteChatMutation()
  const [editing, setEditing] = useState(false)
  // The title being saved, over the one it replaces: shown until the list has the new one, or put back on failure.
  const [saving, setSaving] = useState<{ title: string; over: string } | null>(null)
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const [renameNext, setRenameNext] = useState(false)
  const rowButton = useRef<HTMLButtonElement>(null)
  const input = useRef<HTMLInputElement>(null)
  // The rename ended by Enter or Esc rather than by leaving the field: focus goes back to the row.
  const refocusRow = useRef(false)
  const state = chat.activeRun?.state
  const title = saving !== null && saving.over === chat.title ? saving.title : chat.title

  useEffect(() => {
    if (editing) {
      input.current?.focus()
      input.current?.select()
    } else if (refocusRow.current) {
      refocusRow.current = false
      rowButton.current?.focus()
    }
  }, [editing])

  function finishRename(save: boolean, viaKey: boolean): void {
    if (!editing) return
    const text = input.current?.value.trim() ?? ''
    refocusRow.current = viaKey
    setEditing(false)
    if (!save || text === '' || text === title) return
    setSaving({ title: text, over: chat.title })
    updateChat({ id: chat.id, body: { title: text } })
      .unwrap()
      .catch((error: unknown) => {
        setSaving(null)
        console.error('Could not rename the chat', error)
      })
  }

  const actions: Action[] = [
    { label: 'Rename', icon: PenLine, run: () => setRenameNext(true) },
    ...(platform.files
      ? [
          {
            label: 'Export as Markdown',
            icon: Download,
            run: () => {
              platform.files?.exportChat(chat.id).catch((error: unknown) => {
                console.error('Could not export the chat', error)
              })
            }
          }
        ]
      : []),
    { label: 'Delete', icon: Trash2, run: () => setConfirmingDelete(true), destructive: true }
  ]
  // Rename's field takes focus once the menu has closed, so the closing menu mustn't hand it back to its trigger.
  const finalFocus = !renameNext
  const onMenuClosed = (open: boolean): void => {
    if (open || !renameNext) return
    setRenameNext(false)
    setEditing(true)
  }

  return (
    <li>
      <ContextMenu onOpenChangeComplete={onMenuClosed}>
        <ContextMenuTrigger className="group relative flex select-auto">
          {editing ? (
            <input
              ref={input}
              aria-label="Chat title"
              maxLength={200}
              defaultValue={title}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  finishRename(true, true)
                } else if (event.key === 'Escape') {
                  event.preventDefault()
                  event.stopPropagation()
                  finishRename(false, true)
                }
              }}
              onBlur={() => finishRename(true, false)}
              className="w-full rounded-sm bg-background px-2.5 py-1.5 text-[13px] text-foreground ring-2 ring-sidebar-ring outline-none"
            />
          ) : (
            <button
              ref={rowButton}
              type="button"
              title={title}
              aria-current={current ? 'page' : undefined}
              onClick={() => dispatch(navigated({ tab: 'chat', chatId: chat.id }))}
              className={cn(
                'flex w-full items-center gap-2 rounded-sm py-1.5 pr-8 pl-2.5 text-left text-[13px] outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring',
                current
                  ? 'bg-background text-foreground'
                  : 'text-muted-foreground group-hover:bg-sidebar-accent/60 group-hover:text-sidebar-foreground'
              )}
            >
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate">{title}</span>
                {snippet && snippet.length > 0 && (
                  <span className="truncate text-xs text-muted-foreground">
                    <Snippet parts={snippet} />
                  </span>
                )}
              </span>
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
          )}
          {!editing && (
            <DropdownMenu onOpenChangeComplete={onMenuClosed}>
              <DropdownMenuTrigger
                aria-label={`Actions for ${title}`}
                className="absolute top-1/2 right-1 grid size-6 -translate-y-1/2 place-items-center rounded-sm text-muted-foreground opacity-0 outline-none group-focus-within:opacity-100 group-hover:opacity-100 hover:bg-sidebar-accent hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-sidebar-ring data-popup-open:opacity-100"
              >
                <MoreHorizontal aria-hidden className="size-4" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-44" finalFocus={finalFocus}>
                {actions.map((action) => (
                  <Fragment key={action.label}>
                    {action.destructive && <DropdownMenuSeparator />}
                    <DropdownMenuItem
                      variant={action.destructive ? 'destructive' : 'default'}
                      onClick={action.run}
                    >
                      <action.icon
                        aria-hidden
                        className={cn('size-3.5', !action.destructive && 'text-muted-foreground')}
                      />
                      {action.label}
                    </DropdownMenuItem>
                  </Fragment>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </ContextMenuTrigger>
        <ContextMenuContent className="w-44" finalFocus={finalFocus}>
          {actions.map((action) => (
            <Fragment key={action.label}>
              {action.destructive && <ContextMenuSeparator />}
              <ContextMenuItem variant={action.destructive ? 'destructive' : 'default'} onClick={action.run}>
                <action.icon
                  aria-hidden
                  className={cn('size-3.5', !action.destructive && 'text-muted-foreground')}
                />
                {action.label}
              </ContextMenuItem>
            </Fragment>
          ))}
        </ContextMenuContent>
      </ContextMenu>
      <DeleteChatDialog
        title={title}
        open={confirmingDelete}
        onOpenChange={setConfirmingDelete}
        onConfirm={() => {
          setConfirmingDelete(false)
          deleteChat({ id: chat.id })
            .unwrap()
            .catch((error: unknown) => {
              console.error('Could not delete the chat', error)
            })
        }}
      />
    </li>
  )
}
