import '@fontsource-variable/geist'
import '@fontsource-variable/geist-mono'
import '@fontsource-variable/source-serif-4/opsz.css'
import './styles/globals.css'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { Provider } from 'react-redux'
import type { TabId } from '../../shared/settings'
import { App } from './App'
import { createAppStore } from './store/store'

async function loadLastTab(): Promise<TabId | undefined> {
  try {
    return (await window.api.settings.get()).lastTab
  } catch (error) {
    // Main falls back to defaults on a bad file, so this is rare; start on the default tab rather than not at all.
    console.error('Could not read settings', error)
    return undefined
  }
}

const root = document.getElementById('root')
if (!root) throw new Error('Root element #root not found')

// Read the saved tab before the first render, so the window opens on it instead of flashing the default first.
const store = createAppStore({ settings: window.api.settings, initialTab: await loadLastTab() })

createRoot(root).render(
  <StrictMode>
    <Provider store={store}>
      <App />
    </Provider>
  </StrictMode>
)
