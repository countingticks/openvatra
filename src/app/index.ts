import '@fontsource-variable/geist'
import '@fontsource-variable/geist-mono'
import '@fontsource-variable/source-serif-4/opsz.css'
import './ui/styles/globals.css'

export { App } from './App'
export { createApp } from './createApp'
export { PlatformProvider } from './platform/PlatformProvider'
// The host calls this before anything renders, so the first frame is already in the right theme.
export { followColorScheme } from './ui/theme'
export type { Platform } from './platform/platform'
export type { AppStoreOptions } from './store/store'
