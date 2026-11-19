import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App, createApp, followColorScheme } from '@app'
import type { Settings } from '@shared/settings'
import { desktopPlatform } from './desktopPlatform'

// Before anything renders, so the first frame is already in the right theme.
followColorScheme()

const platform = desktopPlatform(window.api)

async function loadSettings(): Promise<Settings | undefined> {
  try {
    return await platform.prefs.get()
  } catch (error) {
    // Main falls back to defaults on a bad file, so this is rare; start with defaults rather than not at all.
    console.error('Could not read settings', error)
    return undefined
  }
}

const root = document.getElementById('root')
if (!root) throw new Error('Root element #root not found')

// Read settings before the first render, so the window opens on the saved tab and sidebar state instead of
// flashing the defaults first.
const store = createApp({ platform, initialSettings: await loadSettings() })

createRoot(root).render(
  <StrictMode>
    <App platform={platform} store={store} />
  </StrictMode>
)
