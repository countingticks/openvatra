import { Provider } from 'react-redux'
import { PlatformProvider } from './platform/PlatformProvider'
import type { Platform } from './platform/platform'
import { Shell } from './shell/Shell'
import type { AppStore } from './store/store'

/** The whole UI, for a host that has built its platform and store. */
export function App({ platform, store }: { platform: Platform; store: AppStore }): React.JSX.Element {
  return (
    <PlatformProvider platform={platform}>
      <Provider store={store}>
        <Shell />
      </Provider>
    </PlatformProvider>
  )
}
