import { useEffect, useRef, useState } from 'react'
import { ArrowUp, Square } from 'lucide-react'
import { usePlatform } from '@app/platform/usePlatform'
import { composerReducer, sendErrorMessage, type ComposerEvent, type ComposerState } from './composerMachine'

const draftKey = (chatId: string | undefined): string => `chat.draft:${chatId || 'new'}`

const hasText = (text: string): boolean => /\S/.test(text)

const idle: ComposerState = { status: 'idle' }

interface KeyedState {
  /** The draft key of the chat this send cycle belongs to. */
  key: string
  state: ComposerState
}

interface ComposerProps {
  chatId: string | undefined
  /** The chat's active run is queued or running: the button stops it, and Enter queues the message. */
  answering: boolean
  onSend(text: string, requestId: string): Promise<void>
  onStop(): void
  /** The row under the box: the model button and the context meter. */
  footer: React.ReactNode
}

/** The message box: a growing textarea with Send (or Stop while answering), its draft kept per chat. */
export function Composer({ chatId, answering, onSend, onStop, footer }: ComposerProps): React.JSX.Element {
  const { storage } = usePlatform()
  const key = draftKey(chatId)
  const [text, setText] = useState(() => storage.get(key) ?? '')
  const [shownKey, setShownKey] = useState(key)
  // The send cycle belongs to the chat it started in: another chat starts idle.
  const [machine, setMachine] = useState<KeyedState>({ key, state: idle })
  // The state as of the last event, read by handlers that run before React re-renders (two quick Enters).
  const current = useRef(machine)
  const field = useRef<HTMLTextAreaElement>(null)

  /** Moves the send cycle of `forKey`'s chat; an event for a chat no longer shown starts from idle there too. */
  const fire = (forKey: string, event: ComposerEvent): ComposerState => {
    const from = current.current.key === forKey ? current.current.state : idle
    current.current = { key: forKey, state: composerReducer(from, event) }
    setMachine(current.current)
    return current.current.state
  }
  const status = (forKey: string): ComposerState =>
    current.current.key === forKey ? current.current.state : idle

  // Another chat: its own draft. Done while rendering, so the old text never shows there.
  if (shownKey !== key) {
    setShownKey(key)
    setText(storage.get(key) ?? '')
  }
  const shown = machine.key === key ? machine.state : idle

  // The chat shown now, for a send that finishes after the user moved on.
  const shownNow = useRef(key)
  useEffect(() => {
    shownNow.current = key
  }, [key])

  useEffect(() => {
    field.current?.focus()
  }, [chatId])

  function change(next: string): void {
    setText(next)
    storage.set(key, next === '' ? null : next)
    fire(key, { type: 'edited' })
  }

  async function send(): Promise<void> {
    const sentKey = key
    if (!hasText(text) || status(sentKey).status === 'sending') return
    const sending = fire(sentKey, { type: 'send', requestId: crypto.randomUUID() })
    if (sending.status !== 'sending') return
    try {
      await onSend(text, sending.requestId)
    } catch (error) {
      fire(sentKey, { type: 'failed', message: sendErrorMessage(error) })
      return
    }
    fire(sentKey, { type: 'sent' })
    storage.set(sentKey, null)
    // A new chat has its id by now and shows that chat's (empty) draft; elsewhere the sent text goes.
    if (shownNow.current === sentKey) setText('')
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>): void {
    if (event.nativeEvent.isComposing) return
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      void send()
    } else if (event.key === 'Escape' && answering) {
      event.preventDefault()
      onStop()
    }
  }

  const sending = shown.status === 'sending'
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-end gap-1.5 rounded-[18px] border bg-popover p-2 shadow-[0_1px_2px_rgba(24,24,27,0.06)]">
        <label htmlFor="chat-message" className="sr-only">
          Message
        </label>
        <textarea
          id="chat-message"
          ref={field}
          rows={1}
          value={text}
          placeholder="Reply…"
          onChange={(event) => change(event.target.value)}
          onKeyDown={onKeyDown}
          // Grows with its text up to 8 lines (22 px each, plus padding), then scrolls.
          className="field-sizing-content max-h-[188px] min-w-0 flex-1 resize-none overflow-y-auto bg-transparent px-1 py-1.5 text-[15px] leading-[22px] outline-none placeholder:text-muted-foreground"
        />
        {answering ? (
          <button
            type="button"
            aria-label="Stop (Esc)"
            title="Stop (Esc)"
            onClick={onStop}
            className="grid size-[34px] shrink-0 place-items-center rounded-[10px] text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Square aria-hidden className="size-4 fill-current" />
          </button>
        ) : (
          hasText(text) && (
            <button
              type="button"
              aria-label="Send (Enter)"
              title="Send (Enter)"
              disabled={sending}
              onClick={() => void send()}
              className="grid size-[34px] shrink-0 place-items-center rounded-[10px] text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
            >
              <ArrowUp aria-hidden className="size-5" strokeWidth={2.4} />
            </button>
          )
        )}
      </div>
      {shown.status === 'failed' && (
        <p role="alert" className="px-1.5 text-sm text-destructive">
          {shown.message}
        </p>
      )}
      {footer}
    </div>
  )
}
