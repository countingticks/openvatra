import { ModelsDialog, ResumeDownloadsDialog } from '@app/features/models'
import { SettingsDialog } from '@app/features/settings'
import { ErrorBoundary } from './ErrorBoundary'

/** The dialogs that open over any tab. */
export function DialogHost(): React.JSX.Element {
  return (
    <ErrorBoundary>
      <SettingsDialog />
      <ModelsDialog />
      <ResumeDownloadsDialog />
    </ErrorBoundary>
  )
}
