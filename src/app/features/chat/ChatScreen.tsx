import { ModelButton, WelcomeCard } from '@app/features/models'
import { useAppDispatch } from '@app/store/hooks'
import { modelsDialogOpened } from '@app/store/uiSlice'
import { ComingSoon } from '@app/ui/ComingSoon'
import { Ember } from '@app/ui/Ember'
import { PixelBackdrop } from '@app/ui/PixelBackdrop'

/** The Chat tab. `showWelcome` replaces the placeholder with the welcome card while no chat model is installed. */
export function ChatScreen({ showWelcome }: { showWelcome: boolean }): React.JSX.Element {
  const dispatch = useAppDispatch()
  // The backdrop belongs to the conversation area only (design decision), under the content.
  return (
    <div className="relative h-full overflow-hidden">
      <PixelBackdrop />
      <div className="relative h-full">
        {showWelcome ? (
          <div className="flex h-full items-center justify-center p-8">
            <WelcomeCard onSeeOtherModels={() => dispatch(modelsDialogOpened())} />
          </div>
        ) : (
          <ComingSoon
            title="Chat"
            description="Talk to the models on your PC. Chat arrives in a later step."
            art={<Ember state="idle" scale={3} />}
          />
        )}
      </div>
      {/* Final place per the shell design; the message box (Step 3) will sit above it. */}
      <div className="absolute right-4 bottom-3">
        <ModelButton />
      </div>
    </div>
  )
}
