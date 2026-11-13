// The window's Settings: settings.json (the store) without the v6 model keys still waiting for the import. Model
// settings are core's; the window reads and writes them through core itself.
// No Electron imports, so it's unit-testable.
import { type Settings, settingsPatchSchema, settingsSchema } from '../shared/settings'
import type { FilePatch, SettingsStore } from './settingsStore'

export interface SettingsService {
  /** The file without legacyModels. */
  get(): Settings
  /** `patch` is untrusted: anything but a valid SettingsPatch rejects with the ZodError. */
  update(patch: unknown): Promise<Settings>
  /** Called when the file changes in a way the window can see; returns unsubscribe. */
  onChange(listener: (settings: Settings) => void): () => void
}

/** Drops keys whose value is undefined: an optional key left out means "no change". */
function defined<T extends object>(patch: T): Partial<T> {
  return Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined)) as Partial<T>
}

export function createSettingsService(store: SettingsStore): SettingsService {
  const listeners = new Set<(settings: Settings) => void>()

  function get(): Settings {
    // Parsing strips the keys the schema doesn't have, so legacyModels never reaches the window.
    return settingsSchema.parse(store.get())
  }

  async function update(patch: unknown): Promise<Settings> {
    const filePatch: FilePatch = defined(settingsPatchSchema.parse(patch))
    if (Object.keys(filePatch).length > 0) await store.update(filePatch)
    return get()
  }

  let last = JSON.stringify(get())
  store.onChange(() => {
    const settings = get()
    const text = JSON.stringify(settings)
    if (text === last) return
    last = text
    for (const listener of listeners) listener(structuredClone(settings))
  })

  return {
    get,
    update,
    onChange: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }
  }
}
