// The one in-memory copy of settings.json, shared by everything in main. Changes go through `update` (validated
// first by the settings service) or the main-only setters, which save them and only then make them current.
// The model settings core owns are not here (src/main/settingsService.ts composes them in).
// No Electron imports, so it's unit-testable.
import { type SettingsFile, windowBoundsSchema } from '../shared/settings'
import { saveSettings } from './settings'

/** The file keys a window's change may touch; checked by the service (settingsPatchSchema) before it gets here. */
export type FilePatch = Partial<
  Pick<
    SettingsFile,
    | 'theme'
    | 'startWithWindows'
    | 'lastTab'
    | 'closeAction'
    | 'sidebarOpen'
    | 'motion'
    | 'showAdvancedModels'
    | 'cudaOfferDismissed'
  >
>

export interface SettingsStore {
  get(): SettingsFile
  /** `patch` is already validated by the service; keys left undefined mean "no change". */
  update(patch: FilePatch): Promise<SettingsFile>
  /** Main process only; the UI can't reach this, so it can't move or resize the window through settings. */
  setWindowBounds(bounds: unknown): Promise<SettingsFile>
  /** Main process only: the one-time close-to-tray notice has been shown. */
  markCloseToTrayNoticeShown(): Promise<SettingsFile>
  /** After the import's final outcome. */
  dropLegacyModels(): Promise<SettingsFile>
  /** Resolves once every save asked for so far has finished, so quitting doesn't cut one off. */
  whenIdle(): Promise<void>
  /**
   * Calls `listener` after each saved change, with the new and the previous settings. It runs once the change is
   * on disk, so it must handle its own errors: the change already happened. Returns a function that unsubscribes.
   */
  onChange(listener: ChangeListener): () => void
}

export type ChangeListener = (settings: SettingsFile, previous: SettingsFile) => void

/** Drops keys whose value is undefined: an optional key left out means "no change", not "store undefined". */
function defined<T extends object>(patch: T): Partial<T> {
  return Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined)) as Partial<T>
}

export function createSettingsStore(
  filePath: string,
  initial: SettingsFile,
  save: typeof saveSettings = saveSettings
): SettingsStore {
  let current = structuredClone(initial)
  // Each change waits for the one before it, so saves never overlap and land in the order they were asked for.
  let queue: Promise<unknown> = Promise.resolve()
  const listeners = new Set<ChangeListener>()

  /** `change` runs inside the queue, so a validation error becomes this change's rejection. */
  function enqueue(change: (settings: SettingsFile) => SettingsFile): Promise<SettingsFile> {
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

  function setWindowBounds(bounds: unknown): Promise<SettingsFile> {
    return enqueue((settings) => ({ ...settings, window: windowBoundsSchema.parse(bounds) }))
  }

  function dropLegacyModels(): Promise<SettingsFile> {
    return enqueue((settings) => {
      const next = { ...settings }
      delete next.legacyModels
      return next
    })
  }

  // Copies, so callers can't change the store's state behind its back.
  return {
    get: () => structuredClone(current),
    update: (patch) => enqueue((settings) => ({ ...settings, ...defined(patch) })),
    setWindowBounds,
    markCloseToTrayNoticeShown: () => enqueue((settings) => ({ ...settings, closeToTrayNoticeShown: true })),
    dropLegacyModels,
    whenIdle: () => queue.then(() => undefined),
    onChange: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }
  }
}
