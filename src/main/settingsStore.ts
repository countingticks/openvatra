// The one in-memory copy of the settings, shared by everything in main. Changes go through `update` (from the UI)
// or the main-only setters, which validate them, save them, and only then make them current.
// No Electron imports, so it's unit-testable.
import { type Settings, settingsPatchSchema, windowBoundsSchema } from '../shared/settings'
import { saveSettings } from './settings'

export interface SettingsStore {
  get(): Settings
  /** `patch` is untrusted (it comes from the UI): anything but a valid SettingsPatch is rejected. */
  update(patch: unknown): Promise<Settings>
  /** Main process only; the UI can't reach this, so it can't move or resize the window through settings. */
  setWindowBounds(bounds: unknown): Promise<Settings>
  /** Main process only: the one-time close-to-tray notice has been shown. */
  markCloseToTrayNoticeShown(): Promise<Settings>
  /** Resolves once every save asked for so far has finished, so quitting doesn't cut one off. */
  whenIdle(): Promise<void>
}

export function createSettingsStore(
  filePath: string,
  initial: Settings,
  save: typeof saveSettings = saveSettings
): SettingsStore {
  let current = structuredClone(initial)
  // Each change waits for the one before it, so saves never overlap and land in the order they were asked for.
  let queue: Promise<unknown> = Promise.resolve()

  /** `changes` runs inside the queue, so a validation error becomes this change's rejection. */
  function enqueue(changes: () => Partial<Settings>): Promise<Settings> {
    const run = queue.then(async () => {
      const next: Settings = { ...current, ...changes() }
      await save(filePath, next)
      // Only after the save worked: the app never acts on a value that isn't on disk.
      current = next
      return structuredClone(current)
    })
    // A failed change must not block the ones after it.
    queue = run.catch(() => undefined)
    return run
  }

  function update(patch: unknown): Promise<Settings> {
    // `{ theme: undefined }` is valid for an optional key; treat it as "no change", not as a value to store.
    return enqueue(() =>
      Object.fromEntries(
        Object.entries(settingsPatchSchema.parse(patch)).filter(([, value]) => value !== undefined)
      )
    )
  }

  function setWindowBounds(bounds: unknown): Promise<Settings> {
    return enqueue(() => ({ window: windowBoundsSchema.parse(bounds) }))
  }

  // Copies, so callers can't change the store's state behind its back.
  return {
    get: () => structuredClone(current),
    update,
    setWindowBounds,
    markCloseToTrayNoticeShown: () => enqueue(() => ({ closeToTrayNoticeShown: true })),
    whenIdle: () => queue.then(() => undefined)
  }
}
