// The desktop host: maps window.api (the preload bridge) one to one. With main.tsx, the only code that reads it.
import type { Platform } from '@app'
import type { Api } from '@shared/ipc'

/** The renderer's own localStorage (same origin every launch). A store that throws (blocked, full) reads as empty
 * and drops writes, warning once per window. */
function localStorageBacked(): Platform['storage'] {
  let warned = false
  function guard<T>(action: () => T, fallback: T): T {
    try {
      return action()
    } catch {
      if (!warned) console.warn('storage unavailable')
      warned = true
      return fallback
    }
  }
  return {
    get: (key) => guard(() => localStorage.getItem(key), null),
    set: (key, value) =>
      guard(
        () => (value === null ? localStorage.removeItem(key) : localStorage.setItem(key, value)),
        undefined
      )
  }
}

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
    storage: localStorageBacked(),
    window: api.appWindow,
    files: api.files,
    quit: () => api.app.quit()
  }
}
