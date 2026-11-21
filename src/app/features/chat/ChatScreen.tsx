import { useEffect, useRef } from 'react'
import {
  useGetChatQuery,
  useResumeRunMutation,
  useStartRunMutation,
  useStopRunMutation
} from '@app/core/generated'
import { ModelButton, WelcomeCard } from '@app/features/models'
import { answerState, Transcript, useLiveAnswer, useRunView, type RunView } from '@app/features/runs'
import { useAppDispatch, useAppSelector } from '@app/store/hooks'
import { modelsDialogOpened, routeReplaced, selectRoute, settingsOpened } from '@app/store/uiSlice'
import { Button } from '@app/ui/button'
import { Ember } from '@app/ui/Ember'
import { PixelBackdrop } from '@app/ui/PixelBackdrop'
import { Composer } from './Composer'
import { ContextMeter } from './ContextMeter'
import { useAnnouncer } from './useAnnouncer'
import { useChatModel } from './useChatModel'
import { useFollowEnd } from './useFollowEnd'

/** The polite status region: one sentence when an answer finishes or fails, never word by word. */
function Announcer({ view }: { view: RunView | null }): React.JSX.Element {
  return (
    <div role="status" className="sr-only">
      {useAnnouncer(view)}
    </div>
  )
}

/** The Chat tab: one chat's transcript and its message box. The welcome card replaces it while no chat model is installed. */
export function ChatScreen({ showWelcome }: { showWelcome: boolean }): React.JSX.Element {
  const dispatch = useAppDispatch()
  if (!showWelcome) return <ChatView />
  return (
    <div className="relative h-full overflow-hidden">
      <PixelBackdrop />
      <div className="relative flex h-full items-center justify-center p-8">
        <WelcomeCard onSeeOtherModels={() => dispatch(modelsDialogOpened())} />
      </div>
    </div>
  )
}

/** The open chat (or a new one). Its own component, so the conversation's scroll hooks mount with their element. */
function ChatView(): React.JSX.Element {
  const dispatch = useAppDispatch()
  const route = useAppSelector(selectRoute)
  const scroller = useRef<HTMLDivElement>(null)
  const chatId = route.tab === 'chat' && route.chatId ? route.chatId : undefined
  const { view, context, status } = useRunView(chatId)
  const { data: chat } = useGetChatQuery({ id: chatId ?? '' }, { skip: chatId === undefined })
  const { model, loading, pick } = useChatModel(chatId)
  const activeRun = view?.activeRun ?? null
  const live = useLiveAnswer(activeRun?.id)
  const answering = activeRun !== null && (activeRun.state === 'queued' || activeRun.state === 'running')
  const hasLiveEntry = view?.entries.some((entry) => entry.kind === 'live') ?? false
  const [startRun] = useStartRunMutation()
  const [stopRun] = useStopRunMutation()
  const [resumeRun] = useResumeRunMutation()
  const { following, jumpToLatest } = useFollowEnd(scroller, chatId)

  // A saved route to a chat that is gone (deleted elsewhere): open a new chat in its place.
  useEffect(() => {
    if (status === 'notFound') dispatch(routeReplaced({ tab: 'chat' }))
  }, [status, dispatch])

  async function send(text: string, requestId: string): Promise<void> {
    const ref = await startRun({
      // A new chat names the model it shows, so what is shown is what answers.
      startRun: { requestId, text, ...(chatId ? { chatId } : model ? { model } : {}) }
    }).unwrap()
    if (chatId === undefined) dispatch(routeReplaced({ tab: 'chat', chatId: ref.chatId }))
  }

  function stop(): void {
    if (activeRun === null) return
    stopRun({ id: activeRun.id })
      .unwrap()
      .catch((error: unknown) => console.error('Could not stop the answer', error))
  }

  function regenerate(): void {
    if (chatId === undefined) return
    startRun({ startRun: { requestId: crypto.randomUUID(), chatId, replace: 'last' } })
      .unwrap()
      .catch((error: unknown) => console.error('Could not regenerate the answer', error))
  }

  async function edit(text: string): Promise<void> {
    if (chatId === undefined) return
    try {
      await startRun({ startRun: { requestId: crypto.randomUUID(), chatId, text, replace: 'last' } }).unwrap()
    } catch (error) {
      console.error('Could not send the edited message', error)
      throw error
    }
  }

  function resume(runId: string): void {
    resumeRun({ id: runId })
      .unwrap()
      .catch((error: unknown) => console.error('Could not continue the answer', error))
  }

  // The backdrop belongs to the conversation area only (design decision), under the content.
  return (
    <div className="relative h-full overflow-hidden">
      <PixelBackdrop />
      <div className="relative flex h-full flex-col">
        {/* A div, not <header>: the title bar is the window's one banner landmark. */}
        <div className="mt-10 flex h-[34px] shrink-0 items-center px-7">
          <h1 className="truncate text-[15px] font-medium">
            {chatId === undefined ? 'New chat' : (chat?.chat.title ?? '')}
          </h1>
        </div>
        <div
          ref={scroller}
          role="log"
          aria-label="Conversation"
          aria-live="off"
          className="flex-1 overflow-auto px-7 pt-3 pb-6"
        >
          {/* Always there: useFollowEnd watches this one element grow. */}
          <div>
            {view !== null && (
              <Transcript
                view={view}
                model={model ?? ''}
                modelLoading={loading}
                onContinue={resume}
                onOpenModelSettings={() => dispatch(settingsOpened('models'))}
                onRegenerate={regenerate}
                onEdit={edit}
              />
            )}
          </div>
        </div>
        <Announcer key={chatId ?? 'new'} view={view} />
        <div className="px-7 pb-4">
          <div className="relative mx-auto w-full max-w-[720px]">
            <div className="absolute -top-[30px] left-[18px]">
              <Ember state={answerState(activeRun, live, hasLiveEntry)} scale={2} />
            </div>
            {!following && (
              <Button
                variant="outline"
                size="sm"
                onClick={jumpToLatest}
                className="absolute -top-11 left-1/2 -translate-x-1/2 bg-background"
              >
                Jump to latest
              </Button>
            )}
            <Composer
              chatId={chatId}
              model={model}
              answering={answering}
              onSend={send}
              onStop={stop}
              footer={
                <div className="flex items-center justify-end gap-1 px-1.5">
                  <ModelButton model={model} onPick={pick} />
                  <ContextMeter used={context?.used ?? 0} size={context?.size ?? 0} />
                </div>
              }
            />
          </div>
        </div>
      </div>
    </div>
  )
}
