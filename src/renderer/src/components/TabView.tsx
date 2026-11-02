import { ComingSoon } from '@renderer/components/ComingSoon'
import { Ember } from '@renderer/components/Ember'
import { PixelBackdrop } from '@renderer/components/PixelBackdrop'
import { SettingsPage } from '@renderer/components/settings/SettingsPage'
import { useAppSelector } from '@renderer/store/hooks'
import { selectActiveTab } from '@renderer/store/uiSlice'

/** The open tab's content. Each module replaces its placeholder when it arrives. */
export function TabView(): React.JSX.Element {
  switch (useAppSelector(selectActiveTab)) {
    case 'chat':
      // The backdrop belongs to the conversation area only (design decision), under the content.
      return (
        <div className="relative h-full overflow-hidden">
          <PixelBackdrop />
          <div className="relative h-full">
            <ComingSoon
              title="Chat"
              description="Talk to the models on your PC. Chat arrives in a later step."
              art={<Ember state="idle" scale={3} />}
            />
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
    case 'settings':
      return <SettingsPage />
  }
}
