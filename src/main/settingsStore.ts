// The one in-memory copy of the settings, shared by everything in main. Changes go through `update`, which
// validates them, saves them, and only then makes them current. No Electron imports, so it's unit-testable.
import { type Settings, settingsPatchSchema } from '../shared/settings'
import { saveSettings } from './settings'

export interface SettingsStore {
  get(): Settings
  /** `patch` is untrusted (it comes from the UI): anything but a valid SettingsPatch is rejected. */
  update(patch: unknown): Promise<Settings>
}

export function createSettingsStore(
  filePath: string,
  initial: Settings,
  save: typeof saveSettings = saveSettings
): SettingsStore {
  let current = structuredClone(initial)
  // Each update waits for the one before it, so saves never overlap and land in the order they were asked for.
  let queue: Promise<unknown> = Promise.resolve()

  function update(patch: unknown): Promise<Settings> {
    const run = queue.then(async () => {
      // `{ theme: undefined }` is valid for an optional key; treat it as "no change", not as a value to store.
      const changes = Object.entries(settingsPatchSchema.parse(patch)).filter(
        ([, value]) => value !== undefined
      )
      const next: Settings = { ...current, ...Object.fromEntries(changes) }
      await save(filePath, next)
      // Only after the save worked: the app never acts on a value that isn't on disk.
      current = next
      return structuredClone(current)
    })
    // A failed update must not block the ones after it.
    queue = run.catch(() => undefined)
    return run
  }

  // Copies, so callers can't change the store's state behind its back.
  return { get: () => structuredClone(current), update }
}
