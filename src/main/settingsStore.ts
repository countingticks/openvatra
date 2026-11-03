// The one in-memory copy of the settings, shared by everything in main. Changes go through `update` (from the UI)
// or the main-only setters, which validate them, save them, and only then make them current.
// No Electron imports, so it's unit-testable.
import {
  applyPatch,
  type ModelsSettings,
  type Settings,
  settingsPatchSchema,
  windowBoundsSchema
} from '../shared/settings'
import { saveSettings } from './settings'

export interface SettingsStore {
  get(): Settings
  /** `patch` is untrusted (it comes from the UI): anything but a valid SettingsPatch is rejected. */
  update(patch: unknown): Promise<Settings>
  /** Main process only; the UI can't reach this, so it can't move or resize the window through settings. */
  setWindowBounds(bounds: unknown): Promise<Settings>
  /**
   * Main process only: a path the user chose in main's file dialog, or null for the default (llama-server: the
   * bundled one). The UI can't set paths (core runs them).
   */
  setModelPath(key: ModelPathKey, path: string | null): Promise<Settings>
  /** Main process only: the one-time close-to-tray notice has been shown. */
  markCloseToTrayNoticeShown(): Promise<Settings>
  /** Resolves once every save asked for so far has finished, so quitting doesn't cut one off. */
  whenIdle(): Promise<void>
  /**
   * Calls `listener` after each saved change, with the new and the previous settings. It runs once the change is
   * on disk, so it must handle its own errors: the change already happened. Returns a function that unsubscribes.
   */
  onChange(listener: ChangeListener): () => void
}

export type ModelPathKey = keyof Pick<ModelsSettings, 'llamaServerPath' | 'modelsDir'>

export type ChangeListener = (settings: Settings, previous: Settings) => void

export function createSettingsStore(
  filePath: string,
  initial: Settings,
  save: typeof saveSettings = saveSettings
): SettingsStore {
  let current = structuredClone(initial)
  // Each change waits for the one before it, so saves never overlap and land in the order they were asked for.
  let queue: Promise<unknown> = Promise.resolve()
  const listeners = new Set<ChangeListener>()

  /** `change` runs inside the queue, so a validation error becomes this change's rejection. */
  function enqueue(change: (settings: Settings) => Settings): Promise<Settings> {
    const run = queue.then(async () => {
      const next = change(current)
      await save(filePath, next)
      // Only after the save worked: the app never acts on a value that isn't on disk.
      const previous = current
      current = next
      for (const listener of listeners) listener(structuredClone(current), structuredClone(previous))
      return structuredClone(current)
    })
    // A failed change must not block the ones after it.
    queue = run.catch(() => undefined)
    return run
  }

  function update(patch: unknown): Promise<Settings> {
    return enqueue((settings) => applyPatch(settings, settingsPatchSchema.parse(patch)))
  }

  function setWindowBounds(bounds: unknown): Promise<Settings> {
    return enqueue((settings) => ({ ...settings, window: windowBoundsSchema.parse(bounds) }))
  }

  function setModelPath(key: ModelPathKey, path: string | null): Promise<Settings> {
    return enqueue((settings) => ({ ...settings, models: { ...settings.models, [key]: path } }))
  }

  // Copies, so callers can't change the store's state behind its back.
  return {
    get: () => structuredClone(current),
    update,
    setWindowBounds,
    setModelPath,
    markCloseToTrayNoticeShown: () => enqueue((settings) => ({ ...settings, closeToTrayNoticeShown: true })),
    whenIdle: () => queue.then(() => undefined),
    onChange: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }
  }
}
