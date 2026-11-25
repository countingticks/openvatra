import { ResumeDownloadsDialog, useModelSettingsReady } from '@app/features/models'
import { SettingsDialog } from '@app/features/settings'
import { ErrorBoundary } from './ErrorBoundary'

/** The dialogs that open over any tab. */
export function DialogHost(): React.JSX.Element {
  // Keeps Settings › Models' answers loaded, so it opens with its real values in place.
  useModelSettingsReady()
  return (
    <ErrorBoundary>
      <SettingsDialog />
      <ResumeDownloadsDialog />
    </ErrorBoundary>
  )
}
