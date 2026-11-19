// The desktop host: maps window.api (the preload bridge) one to one. With main.tsx, the only code that reads it.
import type { Platform } from '@app'
import type { Api } from '@shared/ipc'

export function desktopPlatform(api: Api): Platform {
  return {
    kind: 'desktop',
    core: {
      state: () => api.core.getState(),
      onState: (callback) => api.core.onState(callback),
      restart: () => api.core.restart(),
      openLog: () => api.core.openLog()
    },
    prefs: api.settings,
    window: api.appWindow,
    files: api.files,
    quit: () => api.app.quit()
  }
}
