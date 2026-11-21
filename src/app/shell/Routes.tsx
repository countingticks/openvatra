import { AutomationsScreen } from '@app/features/automations'
import { ChatScreen } from '@app/features/chat'
import { CodeScreen } from '@app/features/code'
import { selectConnection } from '@app/core/connectionSlice'
import { useListModelsQuery } from '@app/core/generated'
import { useCoreState } from '@app/core/useCoreState'
import { useAppSelector } from '@app/store/hooks'
import { selectActiveTab } from '@app/store/uiSlice'

/** The open tab's content. Each module replaces its placeholder when it arrives. */
export function Routes(): React.JSX.Element {
  const coreState = useCoreState()
  const connection = useAppSelector(selectConnection)
  const { data } = useListModelsQuery(undefined, { skip: connection === null })
  // Only once core is up and has listed the models: before that the list is empty just because nobody has answered
  // yet, and the welcome card would flash over the chat (and its model button) at every start.
  const showWelcome =
    coreState?.status === 'ready' && data !== undefined && data.models.every((model) => model.kind !== 'chat')
  switch (useAppSelector(selectActiveTab)) {
    case 'chat':
      return <ChatScreen showWelcome={showWelcome} />
    case 'code':
      return <CodeScreen />
    case 'automations':
      return <AutomationsScreen />
  }
}
