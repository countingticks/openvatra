import { ComingSoon } from '@renderer/components/ComingSoon'
import { useAppSelector } from '@renderer/store/hooks'
import { selectActiveTab } from '@renderer/store/uiSlice'

/** The open tab's content. Each module replaces its placeholder when it arrives. */
export function TabView(): React.JSX.Element {
  switch (useAppSelector(selectActiveTab)) {
    case 'chat':
      return (
        <ComingSoon title="Chat" description="Talk to the models on your PC. Chat arrives in a later step." />
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
      return <ComingSoon title="Settings" description="General settings arrive in the next update." />
  }
}
