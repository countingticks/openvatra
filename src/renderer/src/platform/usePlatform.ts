import { createContext, useContext } from 'react'
import type { Platform } from './platform'

export const PlatformContext = createContext<Platform | null>(null)

export function usePlatform(): Platform {
  const platform = useContext(PlatformContext)
  // Fail loudly: a component rendered outside the provider is a wiring bug, not a host without features.
  if (!platform) throw new Error('usePlatform needs a PlatformProvider')
  return platform
}
