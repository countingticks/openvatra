import { ComingSoon } from '@renderer/components/ComingSoon'
import { Ember } from '@renderer/components/Ember'
import { ModelButton } from '@renderer/components/ModelButton'
import { PixelBackdrop } from '@renderer/components/PixelBackdrop'
import { WelcomeCard } from '@renderer/components/WelcomeCard'
import { useCoreState } from '@renderer/hooks/useCoreState'
import { useModels } from '@renderer/hooks/useModels'
import { useAppSelector } from '@renderer/store/hooks'
import { selectActiveTab } from '@renderer/store/uiSlice'

/** The open tab's content. Each module replaces its placeholder when it arrives. */
export function TabView(): React.JSX.Element {
  const coreState = useCoreState()
  const noChatModels = useModels().every((model) => model.kind !== 'chat')
  // Only once core is up: before that the model list is empty just because nobody has answered yet.
  const showWelcome = coreState?.status === 'ready' && noChatModels
  switch (useAppSelector(selectActiveTab)) {
    case 'chat':
      // The backdrop belongs to the conversation area only (design decision), under the content.
      return (
        <div className="relative h-full overflow-hidden">
          <PixelBackdrop />
          <div className="relative h-full">
            {showWelcome ? (
              <div className="flex h-full items-center justify-center p-8">
                <WelcomeCard />
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
    case 'code':
      return (
        <ComingSoon title="Code" description="A coding agent for your projects. Coming in a later version." />
      )
    case 'automations':
      return (
        <ComingSoon
          title="Automations"
          description="Tasks that run on their own, on your PC. Coming in a later version."
        />
      )
  }
}
