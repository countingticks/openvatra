import { PlatformContext } from './usePlatform'
import type { Platform } from './platform'

export function PlatformProvider(props: {
  platform: Platform
  children: React.ReactNode
}): React.JSX.Element {
  return <PlatformContext.Provider value={props.platform}>{props.children}</PlatformContext.Provider>
}
