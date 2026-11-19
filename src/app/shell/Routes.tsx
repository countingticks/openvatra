import { AutomationsScreen } from '@app/features/automations'
import { ChatScreen } from '@app/features/chat'
import { CodeScreen } from '@app/features/code'
import { useModels } from '@app/features/models'
import { useCoreState } from '@app/core/useCoreState'
import { useAppSelector } from '@app/store/hooks'
import { selectActiveTab } from '@app/store/uiSlice'

/** The open tab's content. Each module replaces its placeholder when it arrives. */
export function Routes(): React.JSX.Element {
  const coreState = useCoreState()
  const noChatModels = useModels().every((model) => model.kind !== 'chat')
  // Only once core is up: before that the model list is empty just because nobody has answered yet.
  const showWelcome = coreState?.status === 'ready' && noChatModels
  switch (useAppSelector(selectActiveTab)) {
    case 'chat':
      return <ChatScreen showWelcome={showWelcome} />
    case 'code':
      return <CodeScreen />
    case 'automations':
      return <AutomationsScreen />
  }
}
